import Foundation
import CryptoKit
import SQLite3
import Darwin

struct CollectorError: Error, CustomStringConvertible {
    let description: String
    init(_ message: String) { description = message }
}
let verifiedSenders: Set<String> = ["absa", "mobilemoney", "hubtel", "paysmall", "t-cash", "vf-cash", "t cash", "stanchart"]
func normalizeSender(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
func stamp(_ date: Date = Date()) -> String {
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.string(from: date)
}
func parseStamp(_ value: String) -> Date? {
    let format = ISO8601DateFormatter(); format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return format.date(from: value)
}
func digest(_ value: String) -> String { SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined() }
struct CollectorConfig: Codable {
    let version: Int
    let key: String
    let senderAllowlist: [String]
    var senders: [String] { senderAllowlist.map(normalizeSender).sorted() }
    var credentialHash: String { digest(key) }
    func validate() throws {
        guard version == 1, key.range(of: "^alf_[A-Za-z0-9_-]{20,64}$", options: .regularExpression) != nil else { throw CollectorError("Invalid configuration or forwarding-key format. No values displayed.") }
        guard !senders.isEmpty, Set(senders).count == senders.count, Set(senders).isSubset(of: verifiedSenders) else { throw CollectorError("An explicit unique subset of the eight verified sender IDs is required.") }
    }
}
struct Baseline {
    let initializedAt: String
    let initialRowID: Int64
    let lastRowID: Int64
    let senderJSON: String
    let credentialHash: String
    func validate(_ config: CollectorConfig) throws {
        guard parseStamp(initializedAt) != nil, initialRowID >= 0, lastRowID >= initialRowID else { throw CollectorError("Invalid baseline; automatic reset/backfill is forbidden.") }
        guard senderJSON == scopeJSON(config), credentialHash == config.credentialHash else { throw CollectorError("Configuration scope or credential changed. Prior baseline/receipts cannot be reused automatically.") }
    }
}
func scopeJSON(_ config: CollectorConfig) -> String { String(data: try! JSONEncoder().encode(config.senders), encoding: .utf8)! }
struct CapturedMessage {
    let rowID: Int64
    let guid: String
    let sender: String
    let body: String
    let receivedAt: String
    let service: String
    var fingerprint: String { digest(normalizeSender(sender) + "\u{0}" + receivedAt + "\u{0}" + body) }
}
enum SourceHoldReason: String {
    case missingDirection = "missing_direction", missingService = "missing_service", missingSender = "missing_sender"
    case missingGUID = "missing_guid", missingDate = "missing_date", unreadableBody = "unreadable_body"
    case sourceMissing = "source_missing", identityChanged = "identity_changed"
}
struct SourceReference { let rowID: Int64; let guidHash: String? }
struct SourceQuarantine { let reference: SourceReference; let reason: SourceHoldReason }
struct SourceRetryResult {
    let reference: SourceReference
    let quarantine: SourceQuarantine?
    let message: CapturedMessage?
}
struct CaptureBatch {
    let messages: [CapturedMessage]
    let lastRowID: Int64
    let hasMore: Bool
    let quarantined: [SourceQuarantine]
    let retries: [SourceRetryResult]
    let scannedRowCount: Int
    init(messages: [CapturedMessage], lastRowID: Int64, hasMore: Bool,
         quarantined: [SourceQuarantine] = [], retries: [SourceRetryResult] = [], scannedRowCount: Int = 0) {
        self.messages = messages; self.lastRowID = lastRowID; self.hasMore = hasMore
        self.quarantined = quarantined; self.retries = retries; self.scannedRowCount = scannedRowCount
    }
}
// Screening is deliberately conservative: a legitimate payment notice mentioning
// a reference "code" may be excluded. Sender identity and an amount never make
// credential-like text safe. This is a local English-marker safeguard, not a
// promise that every language or possible secret can be recognized.
// Normalize only this screening copy; never change the stored/sent body or its
// fingerprint. Format characters must not split a marker into an allowed word.
func credentialScreeningText(_ value: String, separateControls: Bool = false) -> String {
    let normalized = value.precomposedStringWithCompatibilityMapping.folding(
        options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
        locale: Locale(identifier: "en_US_POSIX")
    )
    var result = ""
    for scalar in normalized.unicodeScalars {
        let category = scalar.properties.generalCategory
        if category == .format || (category == .control && !CharacterSet.whitespacesAndNewlines.contains(scalar)) {
            if separateControls { result.append(" ") }
        } else {
            result.unicodeScalars.append(scalar)
        }
    }
    return result
}
let credentialsPattern: NSRegularExpression = {
    let markers = [
        "otp", "pin", "passcode", "password", "passphrase", "passkey", "code", "secret", "token", "nonce",
        "auth", "verification", "authentication", "authorization", "authorisation", "2fa", "mfa", "login", "signin",
        "otpcode", "pincode", "mpin", "tpin", "verificationcode", "securitycode", "authenticationcode", "authorizationcode", "authorisationcode",
        "onetime", "oneuse", "onetimecode", "oneusecode", "donotshare", "nevershare", "donotdisclose"
    ]
    let separator = "[\\s\\p{Z}\\p{P}\\p{S}\\p{M}_]*"
    let separated = markers.map { marker in
        marker.map { NSRegularExpression.escapedPattern(for: String($0)) }.joined(separator: separator)
    }
    // Digits and connector punctuation may touch an actual credential marker
    // (OTP000000, _code_). Do not let regex word-boundary rules hide it there.
    return try! NSRegularExpression(pattern: "(?<![\\p{L}\\p{M}])(?:" + separated.joined(separator: "|") + ")(?![\\p{L}\\p{M}])", options: [.caseInsensitive])
}()
let alertPattern = try! NSRegularExpression(pattern: "\\bGHS\\b|GH[₵¢]|\\bbalance\\b|\\bpurchase[ \\t]+limit\\b|\\btransfer[ \\t]+of\\b", options: [.caseInsensitive])
func matches(_ regex: NSRegularExpression, _ value: String) -> Bool { regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil }
func containsCredentialLikeContent(_ value: String) -> Bool {
    // A hidden character can split a marker (O<format>TP), or separate it from
    // another word (your<format>OTP). Check both interpretations fail-closed.
    matches(credentialsPattern, credentialScreeningText(value)) ||
        matches(credentialsPattern, credentialScreeningText(value, separateControls: true))
}
func eligible(_ message: CapturedMessage, config: CollectorConfig) throws -> Bool {
    guard message.service == "SMS", config.senders.contains(normalizeSender(message.sender)) else { return false }
    guard !message.guid.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          !message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, parseStamp(message.receivedAt) != nil else { throw CollectorError("Incomplete candidate message; collection cursor retained. No content logged.") }
    return !containsCredentialLikeContent(message.body) && matches(alertPattern, message.body)
}
func pathExists(_ url: URL) throws -> Bool {
    var info = stat(); if lstat(url.path, &info) == 0 { return true }
    guard errno == ENOENT else { throw CollectorError("Cannot inspect local state; refusing automatic reset.") }; return false
}
func ensurePrivateDirectory(_ url: URL) throws {
    if try pathExists(url) {
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw CollectorError("Collector directory must be owned, private and not symlinked.") }
    } else { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
}
func readPrivate(_ url: URL) throws -> Data {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw CollectorError("Required local configuration is absent or unreadable.") }; defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_size <= 65536 else { throw CollectorError("Configuration must be a small owned mode-600 regular file.") }
    return try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
}
func loadConfig(_ directory: URL) throws -> CollectorConfig {
    let config: CollectorConfig
    do { config = try JSONDecoder().decode(CollectorConfig.self, from: readPrivate(directory.appendingPathComponent("config.json"))) }
    catch let error as CollectorError { throw error }
    catch { throw CollectorError("Invalid local configuration; no values displayed.") }
    try config.validate(); return config
}
func saveNewConfig(_ config: CollectorConfig, directory: URL) throws {
    try config.validate(); try ensurePrivateDirectory(directory)
    let url = directory.appendingPathComponent("config.json")
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CollectorError("Configuration already exists or cannot be created; no overwrite performed.") }
    var success = false
    defer { close(fd); if !success { unlink(url.path) } }
    let data = try JSONEncoder().encode(config)
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let written = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if written < 0 && errno == EINTR { continue }
            guard written > 0 else { throw CollectorError("Cannot persist private configuration.") }; offset += written
        }
    }
    guard fsync(fd) == 0 else { throw CollectorError("Cannot flush private configuration.") }; success = true
}
final class CollectorLock {
    private var fd: Int32 = -1
    init(directory: URL) throws {
        fd = open(directory.appendingPathComponent("collector.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
        var info = stat()
        guard fd >= 0, fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), fchmod(fd, 0o600) == 0 else { if fd >= 0 { close(fd) }; fd = -1; throw CollectorError("Cannot obtain private collector lock.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); fd = -1; throw CollectorError("Another collector operation is active; no work performed.") }
    }
    deinit { if fd >= 0 { flock(fd, LOCK_UN); close(fd) } }
}
let sqlTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
enum SQLValue { case text(String), integer(Int64), real(Double), null }
final class SQLDatabase {
    fileprivate var handle: OpaquePointer?
    init(path: String, readOnly: Bool) throws {
        let flags = readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE
        guard sqlite3_open_v2(path, &handle, flags, nil) == SQLITE_OK else { sqlite3_close(handle); handle = nil; throw CollectorError("Cannot open the required local database.") }
        sqlite3_busy_timeout(handle, 5000)
    }
    deinit { sqlite3_close(handle) }
    func prepare(_ sql: String, _ values: [SQLValue] = []) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw CollectorError("Database schema/query unavailable; state retained.") }
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1); let result: Int32
            switch value {
            case .text(let string): result = sqlite3_bind_text(statement, index, string, Int32(string.utf8.count), sqlTransient)
            case .integer(let integer): result = sqlite3_bind_int64(statement, index, integer)
            case .real(let real): result = sqlite3_bind_double(statement, index, real)
            case .null: result = sqlite3_bind_null(statement, index)
            }
            guard result == SQLITE_OK else { sqlite3_finalize(statement); throw CollectorError("Database binding failed; state retained.") }
        }
        return statement
    }
    func execute(_ sql: String, _ values: [SQLValue] = []) throws {
        let statement = try prepare(sql, values); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_DONE else { throw CollectorError("Database write/transaction failed; state retained.") }
    }
    func scalarInt(_ sql: String, _ values: [SQLValue] = []) throws -> Int64 {
        let statement = try prepare(sql, values); defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw CollectorError("Database metadata read failed.") }; return sqlite3_column_int64(statement, 0)
    }
    func transaction<T>(_ block: () throws -> T) throws -> T {
        try execute("begin immediate")
        do { let result = try block(); try execute("commit"); return result }
        catch { try? execute("rollback"); throw error }
    }
}
func columnText(_ statement: OpaquePointer, _ index: Int32) -> String? {
    guard let bytes = sqlite3_column_text(statement, index) else { return nil }
    return String(bytes: UnsafeBufferPointer(start: bytes, count: Int(sqlite3_column_bytes(statement, index))), encoding: .utf8)
}
struct PendingMessage { let guid: String; let sender: String; let body: String; let receivedAt: String; let attempts: Int64 }
struct OutboxStatus: Codable {
    let initializedAt: String
    let lastCapturedRowID: Int64
    let lastSuccessfulCaptureAt: String?
    let sourceScanHasMore: Bool
    let pendingCount: Int64
    let heldForReviewCount: Int64
    let sourceQuarantineCount: Int64
    let unreadableSourceCount: Int64
    let incompleteSourceMetadataCount: Int64
    let firstQuarantinedSourceRowID: Int64?
    let sourceRetryAttempts: Int64
    let acknowledgedCount: Int64
    let failedAttemptCount: Int64
    let lastAcceptedAt: String?
    let senderAllowlist: [String]
}
final class OutboxStore {
    let db: SQLDatabase
    init(directory: URL, readOnly: Bool = false) throws {
        let path = directory.appendingPathComponent("outbox.sqlite")
        var created = false
        if !readOnly {
            try ensurePrivateDirectory(directory)
            let fd = open(path.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
            if fd >= 0 { close(fd); created = true } else if errno != EEXIST { throw CollectorError("Cannot create private outbox.") }
        }
        var info = stat()
        guard lstat(path.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), info.st_mode & 0o077 == 0 else { throw CollectorError("Outbox must be an owned private regular file; no reset performed.") }
        db = try SQLDatabase(path: path.path, readOnly: readOnly)
        let version = try db.scalarInt("pragma user_version")
        guard (created && version == 0) || (!created && version == 3) else { throw CollectorError("Unsupported or incomplete outbox schema; no automatic migration/reset.") }
        if readOnly { try db.execute("pragma query_only=ON") }
        else {
            // DELETE journal avoids retaining old raw payload frames in a WAL;
            // secure_delete clears deleted cells. This is not forensic erasure.
            _ = try db.scalarInt("pragma journal_mode=DELETE")
            try db.execute("pragma synchronous=FULL"); _ = try db.scalarInt("pragma secure_delete=ON"); try db.execute("pragma foreign_keys=ON")
            if created {
                try db.transaction {
                    try db.execute("create table baseline (singleton integer primary key check(singleton=1), version integer not null, initialized_at text not null, initial_rowid integer not null, last_rowid integer not null, senders_json text not null, credential_hash text not null,last_capture_at text,scan_has_more integer not null default 0 check(scan_has_more in (0,1)))")
                    try db.execute("create table seen (guid text primary key, fingerprint text not null, captured_at text not null, acknowledged_at text)")
                    try db.execute("create table pending (guid text primary key references seen(guid), sender text not null, body text not null, received_at text not null, attempts integer not null default 0, last_attempt_at text, last_error_code text, held_at text)")
                    try db.execute("create table totals (singleton integer primary key check(singleton=1), failed_attempts integer not null)")
                    try db.execute("create table source_quarantine (source_rowid integer primary key check(source_rowid>0), guid_hash text check(guid_hash is null or length(guid_hash)=64), reason text not null check(reason in ('missing_direction','missing_service','missing_sender','missing_guid','missing_date','unreadable_body','source_missing','identity_changed')),first_seen_at text not null,last_checked_at text,attempts integer not null default 0 check(attempts>=0))")
                    try db.execute("insert into totals values (1,0)")
                    try db.execute("pragma user_version=3")
                }
            }
        }
    }
    func baseline(config: CollectorConfig) throws -> Baseline {
        let s = try db.prepare("select version,initialized_at,last_rowid,senders_json,credential_hash,initial_rowid from baseline where singleton=1"); defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_ROW, sqlite3_column_int(s, 0) == 1,
              let initialized = columnText(s, 1), let senders = columnText(s, 3), let hash = columnText(s, 4) else { throw CollectorError("No valid explicit future-only baseline; automatic backfill/reset is forbidden.") }
        let result = Baseline(initializedAt: initialized, initialRowID: sqlite3_column_int64(s, 5), lastRowID: sqlite3_column_int64(s, 2), senderJSON: senders, credentialHash: hash)
        try result.validate(config); return result
    }
    func initialize(config: CollectorConfig, maxRowID: Int64, at date: Date) throws {
        try config.validate(); guard maxRowID >= 0 else { throw CollectorError("Invalid source high-water mark.") }
        try db.transaction {
            guard try db.scalarInt("select count(*) from baseline") == 0, try db.scalarInt("select count(*) from seen") == 0,
                  try db.scalarInt("select count(*) from pending") == 0, try db.scalarInt("select count(*) from source_quarantine") == 0 else { throw CollectorError("Existing or orphaned state cannot be overwritten or reinitialized.") }
            try db.execute("insert into baseline(singleton,version,initialized_at,initial_rowid,last_rowid,senders_json,credential_hash) values (1,1,?,?,?,?,?)", [.text(stamp(date)), .integer(maxRowID), .integer(maxRowID), .text(scopeJSON(config)), .text(config.credentialHash)])
        }
    }
    @discardableResult func capture(_ batch: CaptureBatch, config: CollectorConfig) throws -> Int {
        try db.transaction {
            let before = try baseline(config: config)
            guard batch.lastRowID >= before.lastRowID else { throw CollectorError("Collection cursor moved backwards; no transition performed.") }
            var added = 0
            var touched = Set<Int64>()
            for held in batch.quarantined {
                let ref = held.reference
                guard ref.rowID > before.lastRowID, ref.rowID <= batch.lastRowID, touched.insert(ref.rowID).inserted,
                      ref.guidHash == nil || ref.guidHash!.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CollectorError("Invalid source quarantine bounds; capture rolled back.") }
                try db.execute("insert into source_quarantine(source_rowid,guid_hash,reason,first_seen_at) values(?,?,?,?)", [.integer(ref.rowID),ref.guidHash.map(SQLValue.text) ?? .null,.text(held.reason.rawValue),.text(stamp())])
            }
            for message in batch.messages {
                guard message.rowID > before.lastRowID, message.rowID <= batch.lastRowID, touched.insert(message.rowID).inserted else { throw CollectorError("Invalid capture batch bounds; transaction rolled back.") }
                added += try enqueue(message, baseline: before, config: config)
            }
            for retry in batch.retries {
                let ref = retry.reference
                guard ref.rowID > before.initialRowID, ref.rowID <= before.lastRowID, touched.insert(ref.rowID).inserted else { throw CollectorError("Invalid source retry bounds; capture rolled back.") }
                let existing = try db.prepare("select guid_hash from source_quarantine where source_rowid=?", [.integer(ref.rowID)]); defer { sqlite3_finalize(existing) }
                guard sqlite3_step(existing) == SQLITE_ROW, columnText(existing, 0) == ref.guidHash else { throw CollectorError("Source retry reference changed or is absent; capture rolled back.") }
                if let held = retry.quarantine {
                    guard retry.message == nil, held.reference.rowID == ref.rowID,
                          ref.guidHash == nil || held.reference.guidHash == ref.guidHash else { throw CollectorError("Invalid source retry quarantine; capture rolled back.") }
                    try db.execute("update source_quarantine set guid_hash=?,reason=?,last_checked_at=?,attempts=attempts+1 where source_rowid=?", [held.reference.guidHash.map(SQLValue.text) ?? .null,.text(held.reason.rawValue),.text(stamp()),.integer(ref.rowID)])
                } else {
                    if let message = retry.message {
                        guard message.rowID == ref.rowID, ref.guidHash == nil || digest(message.guid) == ref.guidHash else { throw CollectorError("Source retry identity changed; capture rolled back.") }
                        added += try enqueue(message, baseline: before, config: config)
                    }
                    try db.execute("delete from source_quarantine where source_rowid=?", [.integer(ref.rowID)])
                }
            }
            try db.execute("update baseline set last_rowid=?,last_capture_at=?,scan_has_more=? where singleton=1", [.integer(batch.lastRowID),.text(stamp()),.integer(batch.hasMore ? 1 : 0)])
            return added
        }
    }
    private func enqueue(_ message: CapturedMessage, baseline: Baseline, config: CollectorConfig) throws -> Int {
        guard message.rowID > baseline.initialRowID, let received = parseStamp(message.receivedAt), let start = parseStamp(baseline.initializedAt), received >= start else { throw CollectorError("Capture attempted pre-activation history; transaction rolled back.") }
        if try !eligible(message, config: config) { return 0 }
        let existing = try db.prepare("select fingerprint from seen where guid=?", [.text(message.guid)]); defer { sqlite3_finalize(existing) }
        let step = sqlite3_step(existing)
        if step == SQLITE_ROW {
            guard columnText(existing, 0) == message.fingerprint else { throw CollectorError("Stable message identity changed content; transaction rolled back for review.") }; return 0
        }
        guard step == SQLITE_DONE else { throw CollectorError("Dedupe lookup failed; transaction rolled back.") }
        try db.execute("insert into seen values (?,?,?,null)", [.text(message.guid), .text(message.fingerprint), .text(stamp())])
        try db.execute("insert into pending(guid,sender,body,received_at) values (?,?,?,?)", [.text(message.guid), .text(normalizeSender(message.sender)), .text(message.body), .text(message.receivedAt)])
        return 1
    }
    /** Rotate bounded metadata-only retries independently of forward cursor progress. */
    func sourceQuarantine(config: CollectorConfig, limit: Int = 100) throws -> [SourceReference] {
        let before = try baseline(config: config)
        guard limit > 0 && limit <= 100 else { throw CollectorError("Invalid source retry limit.") }
        let s = try db.prepare("select source_rowid,guid_hash from source_quarantine order by attempts,coalesce(last_checked_at,first_seen_at),source_rowid limit ?", [.integer(Int64(limit))]); defer { sqlite3_finalize(s) }
        var refs: [SourceReference] = []
        while true {
            let step = sqlite3_step(s); if step == SQLITE_DONE { return refs }
            guard step == SQLITE_ROW else { throw CollectorError("Source quarantine metadata unavailable.") }
            let row = sqlite3_column_int64(s, 0), hash = columnText(s, 1)
            guard row > before.initialRowID, row <= before.lastRowID,
                  hash == nil || hash!.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw CollectorError("Invalid source quarantine metadata; no reset performed.") }
            refs.append(SourceReference(rowID: row, guidHash: hash))
        }
    }
    func pending(config: CollectorConfig, limit: Int = 100) throws -> [PendingMessage] {
        let activation = try baseline(config: config)
        guard limit > 0 && limit <= 100, let since = parseStamp(activation.initializedAt) else { throw CollectorError("Invalid delivery metadata; no send attempted.") }
        let s = try db.prepare("select p.guid,p.sender,p.body,p.received_at,p.attempts,s.fingerprint from pending p left join seen s on s.guid=p.guid where p.held_at is null order by p.rowid limit ?", [.integer(Int64(limit))]); defer { sqlite3_finalize(s) }
        var result: [PendingMessage] = []
        while true {
            let step = sqlite3_step(s); if step == SQLITE_DONE { return result }
            guard step == SQLITE_ROW, let guid = columnText(s, 0), let sender = columnText(s, 1), let body = columnText(s, 2), let date = columnText(s, 3), let fingerprint = columnText(s, 5),
                  let received = parseStamp(date), received >= since, sqlite3_column_int64(s, 4) >= 0 else { throw CollectorError("Invalid pending event; no payload logged or sent.") }
            let captured = CapturedMessage(rowID: 0, guid: guid, sender: sender, body: body, receivedAt: date, service: "SMS")
            guard try eligible(captured, config: config), captured.fingerprint == fingerprint else { throw CollectorError("Pending event integrity/scope mismatch; no payload sent.") }
            result.append(PendingMessage(guid: guid, sender: sender, body: body, receivedAt: date, attempts: sqlite3_column_int64(s, 4)))
        }
    }
    func acknowledge(_ guid: String, config: CollectorConfig, at date: Date = Date()) throws {
        try db.transaction {
            _ = try baseline(config: config)
            guard try db.scalarInt("select count(*) from pending where guid=?", [.text(guid)]) == 1 else { throw CollectorError("Cannot acknowledge an absent pending event.") }
            try db.execute("update seen set acknowledged_at=? where guid=?", [.text(stamp(date)), .text(guid)])
            try db.execute("delete from pending where guid=?", [.text(guid)]) // body removed with pending row
        }
    }
    /** Preserve an unrecognized payload privately without blocking later alerts or retry flooding. */
    func holdForReview(_ guid: String, config: CollectorConfig) throws {
        try db.transaction {
            _ = try baseline(config: config)
            guard try db.scalarInt("select count(*) from pending where guid=? and held_at is null", [.text(guid)]) == 1 else { throw CollectorError("Cannot hold an absent or already held pending event.") }
            try db.execute("update pending set held_at=?,last_error_code='review_required',last_attempt_at=?,attempts=attempts+1 where guid=?", [.text(stamp()),.text(stamp()),.text(guid)])
            try db.execute("update totals set failed_attempts=failed_attempts+1 where singleton=1")
        }
    }
    func recordFailure(_ guid: String, code: String, config: CollectorConfig) throws {
        let allowed = code == "network" || code == "invalid_ack" || code == "encoding" || code == "review_required" || code.range(of: "^http_[1-5][0-9]{2}$", options: .regularExpression) != nil
        guard allowed else { throw CollectorError("Non-sanitized error code refused.") }
        try db.transaction {
            _ = try baseline(config: config)
            try db.execute("update pending set attempts=attempts+1,last_attempt_at=?,last_error_code=? where guid=?", [.text(stamp()), .text(code), .text(guid)])
            guard sqlite3_changes(db.handle) == 1 else { throw CollectorError("Cannot update absent pending event.") }
            try db.execute("update totals set failed_attempts=failed_attempts+1 where singleton=1")
        }
    }
    func status(config: CollectorConfig) throws -> OutboxStatus {
        let baseline = try baseline(config: config)
        let capture = try db.prepare("select last_capture_at,scan_has_more from baseline where singleton=1"); defer { sqlite3_finalize(capture) }
        guard sqlite3_step(capture) == SQLITE_ROW else { throw CollectorError("Cannot read collection health metadata.") }
        let capturedAt = columnText(capture, 0), hasMore = sqlite3_column_int(capture, 1)
        guard capturedAt == nil || parseStamp(capturedAt!) != nil, hasMore == 0 || hasMore == 1 else { throw CollectorError("Invalid collection health metadata.") }
        let s = try db.prepare("select max(acknowledged_at) from seen"); defer { sqlite3_finalize(s) }
        guard sqlite3_step(s) == SQLITE_ROW else { throw CollectorError("Cannot read acceptance metadata.") }
        let quarantined = try db.scalarInt("select count(*) from source_quarantine")
        return try OutboxStatus(initializedAt: baseline.initializedAt, lastCapturedRowID: baseline.lastRowID,
            lastSuccessfulCaptureAt: capturedAt, sourceScanHasMore: hasMore == 1,
            pendingCount: db.scalarInt("select count(*) from pending"), heldForReviewCount: db.scalarInt("select count(*) from pending where held_at is not null"),
            sourceQuarantineCount: quarantined, unreadableSourceCount: db.scalarInt("select count(*) from source_quarantine where reason='unreadable_body'"),
            incompleteSourceMetadataCount: db.scalarInt("select count(*) from source_quarantine where reason like 'missing_%'"),
            firstQuarantinedSourceRowID: quarantined > 0 ? db.scalarInt("select min(source_rowid) from source_quarantine") : nil,
            sourceRetryAttempts: db.scalarInt("select coalesce(sum(attempts),0) from source_quarantine"),
            acknowledgedCount: db.scalarInt("select count(*) from seen where acknowledged_at is not null"),
            failedAttemptCount: db.scalarInt("select failed_attempts from totals where singleton=1"), lastAcceptedAt: columnText(s, 0), senderAllowlist: config.senders)
    }
}
