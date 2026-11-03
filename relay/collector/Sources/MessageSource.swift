import Foundation
import SQLite3

func appleMessageDate(_ raw: Int64) -> Date {
    Date(timeIntervalSinceReferenceDate: raw > 1_000_000_000_000 ? Double(raw) / 1_000_000_000 : Double(raw))
}
func decodeAttributedMessage(_ data: Data) -> String? {
    let bytes = [UInt8](data)
    guard let marker = data.range(of: Data("NSString".utf8)) else { return nil }
    var index = marker.upperBound - data.startIndex + 5
    guard index < bytes.count else { return nil }
    var length = Int(bytes[index]); index += 1
    if length == 0x81 {
        guard index + 2 <= bytes.count else { return nil }; length = Int(bytes[index]) | Int(bytes[index + 1]) << 8; index += 2
    } else if length == 0x82 {
        guard index + 4 <= bytes.count else { return nil }
        let raw = UInt32(bytes[index]) | UInt32(bytes[index + 1]) << 8 | UInt32(bytes[index + 2]) << 16 | UInt32(bytes[index + 3]) << 24
        guard raw <= 1_000_000 else { return nil }; length = Int(raw); index += 4
    } else if length >= 0x80 { return nil }
    guard length > 0, length <= bytes.count - index else { return nil }
    return String(bytes: bytes[index..<(index + length)], encoding: .utf8)
}
final class MessageSource {
    let db: SQLDatabase
    init(path: String) throws { db = try SQLDatabase(path: path, readOnly: true); try db.execute("pragma query_only=ON") }
    func highWaterMark() throws -> Int64 { try db.scalarInt("select coalesce(max(ROWID),0) from message") }
    /** Validate required schema and header access without selecting any body. */
    func checkHeaderAccess() throws -> Int64 {
        let statement = try db.prepare("select m.ROWID,m.guid,m.date,m.service,m.is_from_me,h.id from message m left join handle h on h.ROWID=m.handle_id limit 0")
        sqlite3_finalize(statement)
        let bodyColumns = try db.prepare("select text,attributedBody from message limit 0")
        sqlite3_finalize(bodyColumns)
        return try highWaterMark()
    }
    private struct Header {
        let rowID: Int64
        let guid: String?
        let date: Int64?
        let sender: String?
        let service: String?
        let fromMe: Int64?
    }
    private enum Evaluation { case excluded; case message(CapturedMessage); case quarantine(SourceQuarantine) }
    private let headers = "select m.ROWID,m.guid,m.date,h.id,m.service,m.is_from_me from message m left join handle h on h.ROWID=m.handle_id"
    private func header(_ statement: OpaquePointer) -> Header {
        Header(rowID: sqlite3_column_int64(statement, 0), guid: columnText(statement, 1),
            date: sqlite3_column_type(statement, 2) == SQLITE_INTEGER ? sqlite3_column_int64(statement, 2) : nil,
            sender: columnText(statement, 3), service: columnText(statement, 4),
            fromMe: sqlite3_column_type(statement, 5) == SQLITE_INTEGER ? sqlite3_column_int64(statement, 5) : nil)
    }
    private func evaluate(_ item: Header, baseline: Baseline, config: CollectorConfig, prior: SourceReference? = nil) throws -> Evaluation {
        guard let since = parseStamp(baseline.initializedAt) else { throw CollectorError("Invalid activation date.") }
        let guid = item.guid.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        let observedHash = guid.map(digest)
        let ref = SourceReference(rowID: item.rowID, guidHash: prior?.guidHash ?? observedHash)
        func held(_ reason: SourceHoldReason) -> Evaluation { .quarantine(SourceQuarantine(reference: ref, reason: reason)) }
        if let expected = prior?.guidHash, let actual = observedHash, expected != actual { return held(.identityChanged) }
        // These routing/date facts are sufficient to exclude without reading a
        // body. Missing routing is not guessed to mean a provider or a person.
        if item.fromMe == 1 { return .excluded }
        if let service = item.service, !service.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, service != "SMS" { return .excluded }
        if let sender = item.sender, !normalizeSender(sender).isEmpty, !config.senders.contains(normalizeSender(sender)) { return .excluded }
        if let raw = item.date, raw > 0, appleMessageDate(raw) < since { return .excluded }
        guard item.fromMe == 0 else { return held(.missingDirection) }
        guard item.service == "SMS" else { return held(.missingService) }
        guard let sender = item.sender, !normalizeSender(sender).isEmpty else { return held(.missingSender) }
        guard let guid else { return held(.missingGUID) }
        guard let date = item.date, date > 0 else { return held(.missingDate) }
        // Only a fully routed, post-activation provider row permits a body read.
        let bodyStatement = try db.prepare("select text,attributedBody from message where ROWID=?", [.integer(item.rowID)])
        defer { sqlite3_finalize(bodyStatement) }
        let step = sqlite3_step(bodyStatement)
        if step == SQLITE_DONE { return held(.sourceMissing) }
        guard step == SQLITE_ROW else { throw CollectorError("Messages body query failed; capture transition retained.") }
        var body = columnText(bodyStatement, 0).flatMap { $0.isEmpty ? nil : $0 }
        if body == nil, let bytes = sqlite3_column_blob(bodyStatement, 1) {
            body = decodeAttributedMessage(Data(bytes: bytes, count: Int(sqlite3_column_bytes(bodyStatement, 1))))
        }
        guard let body, !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !body.contains("\u{0}") else { return held(.unreadableBody) }
        return .message(CapturedMessage(rowID: item.rowID, guid: guid, sender: sender, body: body, receivedAt: stamp(appleMessageDate(date)), service: "SMS"))
    }
    func captureBatch(baseline: Baseline, config: CollectorConfig, limit: Int = 500, retry: [SourceReference] = []) throws -> CaptureBatch {
        try baseline.validate(config)
        guard limit > 0 && limit <= 500, retry.count <= 100, Set(retry.map(\.rowID)).count == retry.count,
              retry.allSatisfy({ $0.rowID > baseline.initialRowID && $0.rowID <= baseline.lastRowID }) else { throw CollectorError("Invalid collection/retry bounds.") }
        try db.execute("begin"); defer { try? db.execute("rollback") }
        let upper = try highWaterMark()
        guard upper >= baseline.lastRowID else { throw CollectorError("Messages database moved backwards. No automatic cursor reset.") }
        var retries: [SourceRetryResult] = []
        for ref in retry {
            let row = try db.prepare(headers + " where m.ROWID=?", [.integer(ref.rowID)]); defer { sqlite3_finalize(row) }
            let step = sqlite3_step(row)
            if step == SQLITE_DONE {
                retries.append(SourceRetryResult(reference: ref, quarantine: SourceQuarantine(reference: ref, reason: .sourceMissing), message: nil)); continue
            }
            guard step == SQLITE_ROW else { throw CollectorError("Source retry query failed; capture transition retained.") }
            switch try evaluate(header(row), baseline: baseline, config: config, prior: ref) {
            case .excluded: retries.append(SourceRetryResult(reference: ref, quarantine: nil, message: nil))
            case .message(let message): retries.append(SourceRetryResult(reference: ref, quarantine: nil, message: message))
            case .quarantine(let held): retries.append(SourceRetryResult(reference: ref, quarantine: held, message: nil))
            }
        }
        // LIMIT applies to scanned headers, never the number of decoded bodies.
        // All progress, good messages and quarantine refs commit together later.
        let s = try db.prepare(headers + " where m.ROWID>? and m.ROWID<=? order by m.ROWID limit ?",
            [.integer(baseline.lastRowID),.integer(upper),.integer(Int64(limit+1))]); defer { sqlite3_finalize(s) }
        var messages: [CapturedMessage] = [], quarantined: [SourceQuarantine] = []
        var hasMore = false, scanned = 0; var lastScanned = baseline.lastRowID
        while true {
            let step = sqlite3_step(s); if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw CollectorError("Messages read failed; no capture transition.") }
            if scanned == limit { hasMore = true; break }
            let item = header(s); scanned += 1; lastScanned = item.rowID
            switch try evaluate(item, baseline: baseline, config: config) {
            case .excluded: break
            case .message(let message): messages.append(message)
            case .quarantine(let held): quarantined.append(held)
            }
        }
        return CaptureBatch(messages: messages, lastRowID: hasMore ? lastScanned : upper, hasMore: hasMore,
            quarantined: quarantined, retries: retries, scannedRowCount: scanned)
    }
}
