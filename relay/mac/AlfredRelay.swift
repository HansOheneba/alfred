// Alfred's macOS relay. Building does not access Messages or the network.
// Runtime requires an explicit provider scope and a future-only baseline.
// --check prints counts only; --status never opens Messages.
import Foundation
import CoreFoundation
import CryptoKit
import SQLite3
import Darwin

let endpoint = URL(string: "https://alfred.hansopoku.com/api/ingest/sms")!
// Verified from the existing Money Dashboard collector and sender metadata.
// Config must choose a subset; there is deliberately no default selection.
let supportedSenders: Set<String> = ["absa", "mobilemoney", "hubtel", "paysmall", "t-cash", "vf-cash", "t cash", "stanchart"]
let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AlfredRelay")
let chatDB = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/chat.db").path
let batchLimit = 500
struct RelayFailure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
func fail(_ message: String) -> RelayFailure { RelayFailure(message) }
func timestamp(_ date: Date = Date()) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
}
func parseDate(_ value: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value)
}
func log(_ message: String) { FileHandle.standardError.write(Data("\(timestamp()) \(message)\n".utf8)) }
func normalizedSender(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }

struct Config: Codable {
    let version: Int
    let key: String
    let senderAllowlist: [String]
    var senders: [String] { senderAllowlist.map(normalizedSender).sorted() }
    var credentialFingerprint: String { SHA256.hash(data: Data(key.utf8)).map { String(format: "%02x", $0) }.joined() }
    func validate() throws {
        guard version == 1 else { throw fail("Unsupported configuration version.") }
        guard key.range(of: "^alf_[A-Za-z0-9_-]{20,64}$", options: .regularExpression) != nil else {
            throw fail("Missing or invalid forwarding key; no Messages were read.")
        }
        guard !senders.isEmpty, Set(senders).count == senders.count, Set(senders).isSubset(of: supportedSenders) else {
            throw fail("Choose a nonempty, unique subset of the documented provider sender IDs. No Messages were read.")
        }
    }
}
struct State: Codable {
    let version: Int
    var lastRowID: Int64
    let initializedAt: String
    let senderAllowlist: [String]
    let credentialFingerprint: String
    var acceptedCount: Int
    var lastAcceptedAt: String?
    func validate(config: Config) throws {
        guard version == 1, lastRowID >= 0, acceptedCount >= 0, parseDate(initializedAt) != nil,
              lastAcceptedAt == nil || parseDate(lastAcceptedAt!) != nil else {
            throw fail("Invalid state. Refusing to backfill or reset the cursor.")
        }
        guard senderAllowlist == config.senders else {
            throw fail("Sender scope changed. Refusing the old cursor; review scope and explicitly initialize a new baseline.")
        }
        guard credentialFingerprint == config.credentialFingerprint else {
            throw fail("Forwarding credential changed. Prior acceptance cannot verify this account; explicitly review a new baseline.")
        }
    }
}
func privateFileData(_ url: URL) throws -> Data {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
    guard fd >= 0 else { throw fail("Required private file is missing or unreadable: \(url.lastPathComponent).") }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), (info.st_mode & S_IFMT) == S_IFREG,
          (info.st_mode & 0o077) == 0, info.st_size <= 64 * 1024 else {
        throw fail("Private file must be a small, owned, regular mode-600 file: \(url.lastPathComponent).")
    }
    return try FileHandle(fileDescriptor: fd, closeOnDealloc: false).readToEnd() ?? Data()
}
func loadConfig(at directory: URL) throws -> Config {
    let config: Config
    do { config = try JSONDecoder().decode(Config.self, from: privateFileData(directory.appendingPathComponent("config.json"))) }
    catch let error as RelayFailure { throw error }
    catch { throw fail("Configuration is invalid; no Messages were read.") }
    try config.validate()
    return config
}
final class StateStore {
    let directory: URL
    var stateURL: URL { directory.appendingPathComponent("state.json") }
    init(_ directory: URL) { self.directory = directory }
    func exists() throws -> Bool { try pathExistsNoFollow(stateURL) }
    func load(config: Config) throws -> State {
        guard try exists() else { throw fail("No future-only baseline. Run --initialize explicitly after setup approval; nothing was sent.") }
        let state: State
        do { state = try JSONDecoder().decode(State.self, from: privateFileData(stateURL)) }
        catch let error as RelayFailure { throw error }
        catch { throw fail("State is corrupt. Refusing to backfill or reset the cursor.") }
        try state.validate(config: config)
        return state
    }
    func save(_ state: State) throws {
        let bytes = try JSONEncoder().encode(state)
        let temporary = directory.appendingPathComponent("state.json.tmp")
        let fd = open(temporary.path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw fail("Cannot create atomic state file; cursor was not advanced.") }
        var renamed = false
        defer { close(fd); if !renamed { unlink(temporary.path) } }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid() else { throw fail("Atomic state path is not an owned regular file.") }
        guard fchmod(fd, 0o600) == 0 else { throw fail("Cannot secure state file.") }
        try bytes.withUnsafeBytes { buffer in
            var offset = 0
            while offset < buffer.count {
                let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw fail("Cannot write state; cursor was not advanced.") }
                offset += count
            }
        }
        guard fsync(fd) == 0 else { throw fail("Cannot flush state; cursor was not advanced.") }
        guard rename(temporary.path, stateURL.path) == 0 else { throw fail("Cannot atomically replace state; cursor was not advanced.") }
        renamed = true
        let directoryFD = open(directory.path, O_RDONLY)
        guard directoryFD >= 0 else { throw fail("Cannot open state directory for durability check.") }
        defer { close(directoryFD) }
        guard fsync(directoryFD) == 0 else { throw fail("Cannot flush state directory. Stop and inspect state before continuing.") }
    }
    func withLock<T>(_ operation: () throws -> T) throws -> T {
        let fd = open(directory.appendingPathComponent("relay.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
        guard fd >= 0 else { throw fail("Cannot open relay lock.") }
        defer { close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_uid == getuid(), fchmod(fd, 0o600) == 0 else { throw fail("Relay lock is not an owned private regular file.") }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else { throw fail("Another relay operation holds the lock; nothing was sent.") }
        defer { flock(fd, LOCK_UN) }
        return try operation()
    }
}
func pathExistsNoFollow(_ url: URL) throws -> Bool {
    var info = stat()
    if lstat(url.path, &info) == 0 { return true }
    guard errno == ENOENT else { throw fail("Cannot inspect existing state. Refusing an automatic reset.") }
    return false
}
// Only the expected NSString archive payload is decoded, with bounds checks.
// Unsupported archives are held for review, never silently skipped as empty.
func decodeAttributedBody(_ data: Data) -> String? {
    let bytes = [UInt8](data)
    guard let marker = data.range(of: Data("NSString".utf8)) else { return nil }
    var index = marker.upperBound - data.startIndex + 5
    guard index < bytes.count else { return nil }
    var length = Int(bytes[index]); index += 1
    if length == 0x81 {
        guard index + 2 <= bytes.count else { return nil }
        length = Int(bytes[index]) | (Int(bytes[index + 1]) << 8); index += 2
    } else if length == 0x82 {
        guard index + 4 <= bytes.count else { return nil }
        let raw = UInt32(bytes[index]) | (UInt32(bytes[index + 1]) << 8) | (UInt32(bytes[index + 2]) << 16) | (UInt32(bytes[index + 3]) << 24)
        guard raw <= 1_000_000 else { return nil }
        length = Int(raw); index += 4
    } else if length >= 0x80 { return nil }
    guard length > 0, length <= bytes.count - index else { return nil }
    return String(bytes: bytes[index..<(index + length)], encoding: .utf8)
}
func appleDate(_ raw: Int64) -> Date {
    Date(timeIntervalSinceReferenceDate: raw > 1_000_000_000_000 ? Double(raw) / 1_000_000_000 : Double(raw))
}
struct Text {
    let rowid: Int64
    let body: String?
    let sender: String
    let receivedAt: Date
    let service: String
}
struct Batch {
    let texts: [Text]
    let upperRowID: Int64
    let hasMore: Bool
    let pendingMetadataRowID: Int64?
    init(texts: [Text], upperRowID: Int64, hasMore: Bool, pendingMetadataRowID: Int64? = nil) {
        self.texts = texts; self.upperRowID = upperRowID; self.hasMore = hasMore; self.pendingMetadataRowID = pendingMetadataRowID
    }
}
final class MessagesDatabase {
    private var db: OpaquePointer?
    init(path: String) throws {
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            sqlite3_close(db); db = nil
            throw fail("Cannot open Messages read-only. Check Full Disk Access for this relay executable.")
        }
        sqlite3_busy_timeout(db, 5000)
    }
    deinit { sqlite3_close(db) }
    private func execute(_ sql: String) throws {
        guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw fail("Messages database operation failed; cursor retained.") }
    }
    func maximumRowID() throws -> Int64 {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, "select coalesce(max(ROWID), 0) from message", -1, &statement, nil) == SQLITE_OK else { throw fail("Cannot read Messages high-water mark.") }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW else { throw fail("Cannot read Messages high-water mark.") }
        return sqlite3_column_int64(statement, 0)
    }
    func readBatch(state: State, config: Config, limit: Int = batchLimit) throws -> Batch {
        try execute("begin")
        defer { try? execute("rollback") }
        let upper = try maximumRowID()
        guard upper >= state.lastRowID else { throw fail("Messages database moved backwards. Refusing an automatic reset/backfill.") }
        let placeholders = Array(repeating: "?", count: config.senders.count).joined(separator: ",")
        // Do not permanently skip an incoming row whose routing metadata has
        // not arrived yet. This reads header fields only, never personal bodies.
        var metadata: OpaquePointer?
        let metadataSQL = """
            select min(m.ROWID) from message m left join handle h on h.ROWID = m.handle_id
            where m.ROWID > ? and m.ROWID <= ? and (m.is_from_me = 0 or m.is_from_me is null)
              and (m.service is null or trim(m.service) = '' or m.service = 'SMS')
              and (h.id is null or trim(h.id) = '' or lower(trim(h.id)) in (\(placeholders)))
              and (m.is_from_me is null or m.service is null or trim(m.service) = '' or h.id is null or trim(h.id) = '' or m.date is null or m.date <= 0)
            """
        guard sqlite3_prepare_v2(db, metadataSQL, -1, &metadata, nil) == SQLITE_OK else { throw fail("Cannot check incoming metadata; cursor retained.") }
        defer { sqlite3_finalize(metadata) }
        sqlite3_bind_int64(metadata, 1, state.lastRowID); sqlite3_bind_int64(metadata, 2, upper)
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (index, sender) in config.senders.enumerated() { sqlite3_bind_text(metadata, Int32(index + 3), sender, -1, transient) }
        guard sqlite3_step(metadata) == SQLITE_ROW else { throw fail("Incoming metadata check failed; cursor retained.") }
        let pending: Int64? = sqlite3_column_type(metadata, 0) == SQLITE_NULL ? nil : sqlite3_column_int64(metadata, 0)
        let safeUpper = pending.map { $0 - 1 } ?? upper
        // Provider, direction, service and activation-time filters run in SQL,
        // before a personal body is selected. Later-synced old history stays out.
        let sql = """
            select m.ROWID, m.text, m.attributedBody, m.date, h.id, m.service
            from message m join handle h on h.ROWID = m.handle_id
            where m.ROWID > ? and m.ROWID <= ? and m.is_from_me = 0
              and m.service = 'SMS' and lower(trim(h.id)) in (\(placeholders))
              and (case when m.date > 1000000000000 then m.date / 1000000000.0 else m.date end) >= ?
            order by m.ROWID limit ?
            """
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else { throw fail("Cannot prepare provider-scoped Messages query; cursor retained.") }
        defer { sqlite3_finalize(statement) }
        sqlite3_bind_int64(statement, 1, state.lastRowID); sqlite3_bind_int64(statement, 2, safeUpper)
        for (index, sender) in config.senders.enumerated() { sqlite3_bind_text(statement, Int32(index + 3), sender, -1, transient) }
        let dateIndex = Int32(config.senders.count + 3)
        guard let start = parseDate(state.initializedAt) else { throw fail("Invalid activation date.") }
        sqlite3_bind_double(statement, dateIndex, start.timeIntervalSinceReferenceDate)
        sqlite3_bind_int64(statement, dateIndex + 1, Int64(limit + 1))
        var texts: [Text] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw fail("Messages query failed mid-read; cursor retained.") }
            let plain = sqlite3_column_text(statement, 1).map { String(cString: $0) }
            var body = plain.flatMap { $0.isEmpty ? nil : $0 }
            if body == nil, let blob = sqlite3_column_blob(statement, 2) {
                body = decodeAttributedBody(Data(bytes: blob, count: Int(sqlite3_column_bytes(statement, 2))))
            }
            texts.append(Text(rowid: sqlite3_column_int64(statement, 0), body: body,
                              sender: String(cString: sqlite3_column_text(statement, 4)),
                              receivedAt: appleDate(sqlite3_column_int64(statement, 3)),
                              service: String(cString: sqlite3_column_text(statement, 5))))
        }
        return Batch(texts: Array(texts.prefix(limit)), upperRowID: safeUpper, hasMore: texts.count > limit, pendingMetadataRowID: pending)
    }
}
// Broader than the reference's OTP filter: credential-bearing provider texts
// stay local even if they also mention an amount or a balance.
let excludedPattern = try! NSRegularExpression(pattern: "\\b(OTP|PIN|passcode|password)\\b|\\b(verification|security|authentication|authorization)[ \\t]+code\\b|one[ .-]?time[ \\t]+code\\b", options: [.caseInsensitive])
let alertPattern = try! NSRegularExpression(pattern: "\\bGHS\\b|GH[₵¢]|\\bbalance\\b|\\bpurchase[ \\t]+limit\\b|\\btransfer[ \\t]+of\\b", options: [.caseInsensitive])
func matches(_ expression: NSRegularExpression, _ body: String) -> Bool { expression.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)) != nil }
func shouldSend(_ text: Text, config: Config) throws -> Bool {
    guard text.service == "SMS", config.senders.contains(normalizedSender(text.sender)) else { return false }
    guard let body = text.body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        throw fail("Message row \(text.rowid) cannot be decoded. Cursor retained; operator review required (no text logged).")
    }
    return !matches(excludedPattern, body) && matches(alertPattern, body)
}
enum SendResult: Equatable { case accepted, retry(String) }
func classifyResponse(status: Int?, data: Data?, transportError: Bool) -> SendResult {
    guard !transportError, let status else { return .retry("network failure") }
    guard (200..<300).contains(status) else { return .retry("HTTP \(status)") }
    guard let data, let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ok = object["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
          ["found", "duplicates", "needsLabel"].allSatisfy({ key in
              guard let number = object[key] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
              return number.doubleValue.isFinite && number.doubleValue >= 0 && number.doubleValue <= Double(Int.max) && number.doubleValue.rounded() == number.doubleValue
          }) else { return .retry("invalid success acknowledgement") }
    return .accepted
}
final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
final class SendBox: @unchecked Sendable {
    private let lock = NSLock(); private var result: SendResult = .retry("request timeout")
    func set(_ value: SendResult) { lock.lock(); result = value; lock.unlock() }
    func get() -> SendResult { lock.lock(); defer { lock.unlock() }; return result }
}
func send(_ text: Text, config: Config) -> SendResult {
    guard let body = text.body else { return .retry("undecodable body") }
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"; request.timeoutInterval = 30
    request.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do { request.httpBody = try JSONSerialization.data(withJSONObject: ["text": String(body.prefix(4000)), "sender": String(text.sender.prefix(80)), "source": "mac", "receivedAt": timestamp(text.receivedAt)]) }
    catch { return .retry("payload encoding failure") }
    let settings = URLSessionConfiguration.ephemeral
    settings.urlCache = nil; settings.httpCookieStorage = nil; settings.httpShouldSetCookies = false
    settings.requestCachePolicy = .reloadIgnoringLocalCacheData
    settings.timeoutIntervalForRequest = 30; settings.timeoutIntervalForResource = 35
    let session = URLSession(configuration: settings, delegate: NoRedirects(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let box = SendBox(); let done = DispatchSemaphore(value: 0)
    let task = session.dataTask(with: request) { data, response, error in
        box.set(classifyResponse(status: (response as? HTTPURLResponse)?.statusCode, data: data, transportError: error != nil)); done.signal()
    }
    task.resume()
    guard done.wait(timeout: .now() + 40) == .success else { task.cancel(); return .retry("request timeout") }
    return box.get()
}
struct ProcessingSummary { var accepted = 0; var excluded = 0 }
func process(_ batch: Batch, state: inout State, config: Config, checkOnly: Bool,
             persist: (State) throws -> Void, transmit: (Text) -> SendResult) throws -> ProcessingSummary {
    var summary = ProcessingSummary()
    for text in batch.texts {
        if try shouldSend(text, config: config) {
            if !checkOnly {
                switch transmit(text) {
                case .accepted: state.acceptedCount += 1; state.lastAcceptedAt = timestamp()
                case .retry(let reason): throw fail("Delivery held at row \(text.rowid): \(reason). Cursor retained; no message was discarded.")
                }
            }
            summary.accepted += 1
        } else { summary.excluded += 1 }
        if !checkOnly { state.lastRowID = text.rowid; try persist(state) }
    }
    if !checkOnly && !batch.hasMore && batch.upperRowID > state.lastRowID { state.lastRowID = batch.upperRowID; try persist(state) }
    if !batch.hasMore, let pending = batch.pendingMetadataRowID {
        throw fail("Incoming message metadata at row \(pending) is incomplete. Cursor retained before that row; operator review/retry required.")
    }
    return summary
}
@_silgen_name("sandbox_init_with_parameters")
func sandbox_init_with_parameters(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ parameters: UnsafePointer<UnsafePointer<CChar>?>, _ errorbuf: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32
func lockDown() throws {
    var error: UnsafeMutablePointer<CChar>?
    let status = FileManager.default.homeDirectoryForCurrentUser.path.withCString { home in
        "HOME".withCString { key in
            let parameters: [UnsafePointer<CChar>?] = [key, home, nil]
            return sandbox_init_with_parameters(sandboxProfile, 0, parameters, &error)
        }
    }
    guard status == 0 else { throw fail("Sandbox initialization failed. Refusing to run unsandboxed.") }
}
func statusReport(config: Config, store: StateStore) throws {
    let state = try store.load(config: config)
    let report: [String: Any] = ["configurationReady": true, "senderAllowlist": config.senders, "services": ["SMS"],
                               "initializedAt": state.initializedAt, "lastRowID": state.lastRowID,
                               "acceptedCount": state.acceptedCount, "lastAcceptedAt": state.lastAcceptedAt as Any? ?? NSNull(),
                               "destination": endpoint.absoluteString, "apiAcceptanceVerified": state.lastAcceptedAt != nil]
    let data = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    FileHandle.standardOutput.write(data + Data("\n".utf8))
}
func run() -> Int32 {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard arguments.isEmpty || arguments == ["--initialize"] || arguments == ["--status"] || arguments == ["--check"] else {
        log("Usage: alfred-relay [--initialize | --status | --check]. No operation performed."); return 2
    }
    do {
        try lockDown()
        let config = try loadConfig(at: support); let store = StateStore(support)
        if arguments == ["--status"] { try statusReport(config: config, store: store); return 0 }
        return try store.withLock {
            if arguments == ["--initialize"] {
                guard try !store.exists(), try !pathExistsNoFollow(support.appendingPathComponent("last-rowid")) else {
                    throw fail("Existing or legacy state found. Initialization never overwrites history or silently resets scope.")
                }
                let started = timestamp(); let db = try MessagesDatabase(path: chatDB)
                let state = State(version: 1, lastRowID: try db.maximumRowID(), initializedAt: started, senderAllowlist: config.senders,
                                  credentialFingerprint: config.credentialFingerprint, acceptedCount: 0, lastAcceptedAt: nil)
                try store.save(state); log("Future-only baseline initialized. No historical texts were read or sent."); return 0
            }
            var state = try store.load(config: config)
            let db = try MessagesDatabase(path: chatDB); let batch = try db.readBatch(state: state, config: config)
            let checking = arguments == ["--check"]
            let result = try process(batch, state: &state, config: config, checkOnly: checking, persist: store.save, transmit: { send($0, config: config) })
            if checking { print("\(result.accepted) provider alert(s) eligible; \(result.excluded) excluded. No contents printed, sends made, or cursor changes.") }
            else { log("Run completed: \(result.accepted) alert(s) accepted by Alfred; \(result.excluded) excluded; morePending=\(batch.hasMore).") }
            return 0
        }
    } catch {
        log((error as? RelayFailure)?.description ?? "Local relay operation failed. Inspect permissions/state; no automatic reset performed."); return 1
    }
}
#if !RELAY_TEST
exit(run())
#endif
