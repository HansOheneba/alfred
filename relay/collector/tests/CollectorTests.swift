import Foundation
import SQLite3
import Darwin

struct FixtureFailure: Error { let label: String }
var assertions = 0
func expect(_ condition: @autoclosure () throws -> Bool, _ label: String) throws { assertions += 1; if try !condition() { throw FixtureFailure(label: label) } }
func expectError(_ label: String, _ action: () throws -> Void) throws { do { try action() } catch { assertions += 1; return }; throw FixtureFailure(label: label) }
let epoch = Date(timeIntervalSince1970: 1_794_000_000)
func config(_ senders: [String] = ["mobilemoney"]) -> CollectorConfig { CollectorConfig(version: 1, key: "alf_" + String(repeating: "x", count: 24), senderAllowlist: senders) }
func message(_ row: Int64, _ guid: String? = nil, _ body: String = "Fixture payment GHS 25", sender: String = "MobileMoney", service: String = "SMS", date: Date = epoch.addingTimeInterval(1)) -> CapturedMessage {
    CapturedMessage(rowID: row, guid: guid ?? "fixture-guid-\(row)", sender: sender, body: body, receivedAt: stamp(date), service: service)
}
func directory() throws -> URL {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-collector-fixtures-" + UUID().uuidString).resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]); return path
}
func withStore(_ action: (OutboxStore, URL) throws -> Void) throws {
    let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
    let store = try OutboxStore(directory: root); try store.initialize(config: config(), maxRowID: 0, at: epoch)
    try action(store, root)
}
func testSelection() throws {
    try config(Array(verifiedSenders)).validate()
    for senders in [[], ["gcb"], ["achieve"], ["mtn"], ["telecel"], ["friend"], ["mobilemoney", "MOBILEMONEY"]] { try expectError("unsupported/empty/duplicate scope") { try config(senders).validate() } }
    try expect(eligible(message(1), config: config()), "provider alert eligible")
    for sender in ["friend", "MobileMoney-personal", "MobileMoney@example.com", "GCB", "MTN", "Telecel", "Achieve"] { try expect(!eligible(message(1, sender: sender), config: config()), "unapproved sender excluded") }
    for service in ["RCS", "iMessage", ""] { try expect(!eligible(message(1, service: service), config: config()), "non-SMS excluded") }
    for body in ["Fixture OTP GHS 1", "Fixture PIN:1 balance", "Fixture password balance", "Fixture passcode GHS 1", "Fixture verification code balance", "Fixture security code GHS 1", "Fixture authentication code balance", "Fixture one-time code GHS 1", "Fixture ordinary notice", "Fixture GHSfriend"] { try expect(!eligible(message(1, nil, body), config: config()), "credential and nonalert exclusion") }
    // All text below is fabricated. Diagnostics deliberately report only test
    // labels, never bodies, credential-like values, keys or message fingerprints.
    let credentialVariants = [
        "Fixture verification-code GHS 1", "Fixture code GHS 1", "Fixture security/code balance",
        "Fixture verification\u{00a0}code GHS 1", "Fixture verification\u{202f}code balance",
        "Fixture security\ncode GHS 1", "Fixture authentication\rcode balance", "Fixture authorisation-code GHS 1",
        "Fixture O.T.P. GHS 1", "Fixture O T P balance", "Fixture P-I-N GHS 1", "Fixture pass_code GHS 1",
        "Fixture pass—word balance", "Fixture p a s s w o r d GHS 1", "Fixture one-use code GHS 1",
        "Fixture one_time_code GHS 1", "Fixture one\u{2011}time password balance", "Fixture verificationcode GHS 1",
        "Fixture _code_ GHS 1", "Fixture OTP000000 GHS 1", "Fixture 000000PIN balance", "Fixture pincode GHS 1",
        "Fixture password000000 GHS 1", "Fixture code000000 GHS 1", "Fixture 000000OTP balance", "Fixture verification-code:000000 GHS 1",
        "Fixture ＣＯＤＥ GHS 1", "Fixture ｐｉｎ balance", "Fixture vérification GHS 1",
        "Fixture O\u{200b}TP GHS 1", "Fixture p\u{2060}in balance", "Fixture c\u{034f}ode GHS 1",
        "Fixture your\u{200b}OTP GHS 1", "Fixture payment\u{2060}code balance", "Fixture your\u{0000}PIN GHS 1",
        "Fixture p\u{0000}in balance", "Fixture auth\u{202e}entication GHS 1", "Fixture verification\u{0007}-code GHS 1",
        "Fixture auth GHS 1", "Fixture 2FA GHS 1", "Fixture MFA balance", "Fixture login GHS 1", "Fixture sign-in balance",
        "Fixture passkey GHS 1", "Fixture passphrase balance", "Fixture secret GHS 1", "Fixture token balance",
        "Fixture nonce GHS 1", "Fixture do not share balance", "Fixture never-share GHS 1", "Fixture do-not-disclose balance",
        // Conservative tradeoff: reference-code wording is excluded even when
        // the same text otherwise resembles a legitimate payment receipt.
        "Fixture payment received GHS 25; transaction code REF-FICTIONAL"
    ]
    for (index, body) in credentialVariants.enumerated() {
        try expect(!eligible(message(1, nil, body), config: config()), "credential variant \(index) excluded before capture")
    }
    for body in [
        "Fixture payment received GHS 25; available balance GHS 40",
        "Fixture shopping payment GHS 25", "Fixture spinning business GHS 25", "Fixture pinwheel equipment GHS 25", "Fixture payment from Pine House GHS 25",
        "Fixture credited GH₵25.00; reference REF-FICTIONAL"
    ] {
        try expect(eligible(message(1, nil, body), config: config()), "ordinary payment text remains eligible")
    }
    try withStore { store, _ in
        let original = "Fixture received GHS 25; reference REF-FICTIONAL"
        let accepted = message(1, "fixture-normalized-allowed", original)
        let rejected = message(2, "fixture-normalized-credential", "Fixture verification-code GHS 1")
        try expect(store.capture(CaptureBatch(messages: [accepted, rejected], lastRowID: 2, hasMore: false), config: config()) == 1, "credential text never enters pending outbox")
        let pending = try store.pending(config: config())
        try expect(pending.count == 1 && pending[0].guid == accepted.guid && pending[0].body == original, "screening does not alter retained payload")
        try expect(store.db.scalarInt("select count(*) from seen") == 1, "excluded credential has no delivery or dedupe row")
        let status = String(data: try JSONEncoder().encode(store.status(config: config())), encoding: .utf8)!
        try expect(!status.contains(original) && !status.contains(rejected.body) && !status.contains(config().key), "status excludes screening contents and credentials")
    }
    try expectError("empty candidate held") { _ = try eligible(message(1, nil, ""), config: config()) }
    for malformed in [Data(), Data("NSString".utf8), Data("NSString12345".utf8) + Data([0x81, 0xff]), Data("NSString12345".utf8) + Data([0x82, 0xff, 0xff, 0xff, 0xff])] { try expect(decodeAttributedMessage(malformed) == nil, "malformed archive held") }
    let body = "Fixture GHS 1"
    try expect(decodeAttributedMessage(Data("NSString12345".utf8) + Data([UInt8(body.utf8.count)]) + Data(body.utf8)) == body, "synthetic archive decoded")
}
func testTransactionsAndRetention() throws {
    try withStore { store, root in
        try expectError("no baseline overwrite") { try store.initialize(config: config(), maxRowID: 100, at: epoch) }
        let count = try store.capture(CaptureBatch(messages: [message(1), message(2, nil, "Fixture OTP balance"), message(3)], lastRowID: 3, hasMore: false), config: config())
        try expect(count == 2 && store.status(config: config()).pendingCount == 2, "filtered capture persisted")
        try expect(store.baseline(config: config()).lastRowID == 3, "cursor and outbox committed")
        let readOnly = try OutboxStore(directory: root, readOnly: true)
        try expect(readOnly.status(config: config()).pendingCount == 2, "metadata status can open read-only")
        try store.acknowledge("fixture-guid-1", config: config(), at: epoch.addingTimeInterval(3))
        try expect(store.status(config: config()).acknowledgedCount == 1 && store.pending(config: config()).map(\.guid) == ["fixture-guid-3"], "ack logically deletes pending raw row")
        try expect(store.db.scalarInt("select count(*) from pragma_table_info('seen') where name='body'") == 0, "ack metadata never stores body")
        try expect(store.db.scalarInt("pragma secure_delete") == 1, "secure-delete enabled")
        try expectError("same GUID changed content rolls entire capture back") {
            _ = try store.capture(CaptureBatch(messages: [message(4), message(5, "fixture-guid-1", "Fixture changed GHS 999")], lastRowID: 5, hasMore: false), config: config())
        }
        try expect(store.baseline(config: config()).lastRowID == 3 && store.db.scalarInt("select count(*) from seen where guid='fixture-guid-4'") == 0, "failed capture leaves no partial event/cursor")
        _ = try store.capture(CaptureBatch(messages: [message(4, "fixture-guid-1")], lastRowID: 4, hasMore: false), config: config())
        try expect(store.status(config: config()).pendingCount == 1, "acknowledged GUID not requeued")
        try expectError("history cannot enter outbox") { _ = try store.capture(CaptureBatch(messages: [message(5, date: epoch.addingTimeInterval(-1))], lastRowID: 5, hasMore: false), config: config()) }
        let changed = CollectorConfig(version: 1, key: "alf_" + String(repeating: "y", count: 24), senderAllowlist: ["mobilemoney"])
        try expectError("key change invalidates state") { _ = try store.status(config: changed) }
        try expectError("scope change invalidates state") { _ = try store.status(config: config(["hubtel"])) }
        let lock = try CollectorLock(directory: root)
        try expectError("single collector lock") { _ = try CollectorLock(directory: root) }
        withExtendedLifetime(lock) {}
    }
}
func testDelivery() throws {
    let sample = PendingMessage(guid: "fixture-guid-1", sender: "mobilemoney", body: "Fixture payment GHS 25", receivedAt: stamp(epoch.addingTimeInterval(1)), attempts: 0)
    let good = try durableReceiptData(sample)
    try expect(classifyAcknowledgement(status: 200, data: good, networkError: false, expectedEventId: collectorEventID(sample), expectedOwnerId: fixtureReceiptOwner, expectedPayloadHash: collectorPayloadHash(sample)) == .accepted, "strict valid durable ack")
    for status in [301, 400, 401, 403, 408, 413, 429, 500, 503] { try expect(classifyAcknowledgement(status: status, data: good, networkError: false) != .accepted, "all rejections retained") }
    for bad in ["{}", "{\"ok\":false}", "{\"ok\":1,\"found\":1,\"duplicates\":0,\"needsLabel\":0}", "{\"ok\":true,\"found\":true,\"duplicates\":0,\"needsLabel\":0}", "{\"ok\":true,\"found\":-1,\"duplicates\":0,\"needsLabel\":0}"] { try expect(classifyAcknowledgement(status: 200, data: Data(bad.utf8), networkError: false) != .accepted, "malformed successes retained") }
    try expect(classifyAcknowledgement(status: 200, data: good, networkError: true) == .retry("network"), "network errors retained")
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages: [message(1), message(2)], lastRowID: 2, hasMore: false), config: config())
        var sent: [String] = []
        try expectError("retry stops delivery only") { _ = try deliverPending(store: store, config: config()) { item, _ in sent.append(item.guid); return .retry("http_401") } }
        try expect(sent == ["fixture-guid-1"] && store.status(config: config()).pendingCount == 2, "failed send retained without dropping later payload")
        try expect(store.status(config: config()).lastCapturedRowID == 2 && store.status(config: config()).failedAttemptCount == 1, "delivery failure independent of capture cursor")
        _ = try store.capture(CaptureBatch(messages: [message(3)], lastRowID: 3, hasMore: false), config: config())
        try expect(store.status(config: config()).pendingCount == 3, "collection progresses despite delivery failure")
        let delivered = try deliverPending(store: store, config: config()) { item, _ in
            classifyAcknowledgement(status: 200, data: try? durableReceiptData(item, disposition: "duplicate"), networkError: false,
                expectedEventId: collectorEventID(item), expectedOwnerId: fixtureReceiptOwner, expectedPayloadHash: collectorPayloadHash(item))
        }
        try expect(delivered == 3 && store.status(config: config()).pendingCount == 0 && store.status(config: config()).acknowledgedCount == 3, "duplicate retry acknowledges and deletes raw rows")
        try expectError("non-sanitized error rejected") { try store.recordFailure("fixture-guid-1", code: "credential-like-content", config: config()) }
        let output = String(data: try JSONEncoder().encode(store.status(config: config())), encoding: .utf8)!
        try expect(!output.contains("Fixture") && !output.contains(config().key) && !output.contains("credentialHash"), "status contains no body/key/fingerprint")
    }
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages: [message(1)], lastRowID: 1, hasMore: false), config: config())
        try store.db.execute("create trigger synthetic_ack_failure before delete on pending begin select raise(abort,'synthetic failure'); end")
        var acknowledgedByTransport = false
        try expectError("local failure after API acknowledgement retains pending payload") {
            _ = try deliverPending(store: store, config: config()) { _, _ in acknowledgedByTransport = true; return .accepted }
        }
        try expect(acknowledgedByTransport && store.status(config: config()).pendingCount == 1 && store.status(config: config()).acknowledgedCount == 0, "receipt/delete rollback atomic after ack")
        try store.db.execute("drop trigger synthetic_ack_failure")
        _ = try deliverPending(store: store, config: config()) { _, _ in .accepted }
        try expect(store.status(config: config()).pendingCount == 0 && store.status(config: config()).acknowledgedCount == 1, "safe retry eventually commits receipt and payload removal")
    }
    for (column, value) in [("body", "Fixture OTP balance"), ("sender", "friend"), ("received_at", stamp(epoch.addingTimeInterval(-1))), ("body", "Fixture changed GHS 77")] {
        try withStore { store, _ in
            _ = try store.capture(CaptureBatch(messages: [message(1)], lastRowID: 1, hasMore: false), config: config())
            try store.db.execute("update pending set \(column)=?", [.text(value)])
            var attempted = false
            try expectError("pending corruption fails before delivery") { _ = try deliverPending(store: store, config: config()) { _, _ in attempted = true; return .accepted } }
            try expect(!attempted && store.status(config: config()).pendingCount == 1, "corrupted pending payload retained for review without sending")
        }
    }
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages:[message(1)],lastRowID:1,hasMore:false),config:config())
        try store.db.execute("pragma foreign_keys=OFF")
        try store.db.execute("delete from baseline"); try store.db.execute("delete from seen")
        try expectError("orphan pending state cannot acquire a new baseline") { try store.initialize(config:config(),maxRowID:999,at:epoch) }
        try expect(store.db.scalarInt("select count(*) from baseline") == 0 && store.db.scalarInt("select count(*) from pending") == 1, "orphan state remains untouched for explicit review")
    }
}
func testDeliveryBudget() throws {
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages:[message(1),message(2),message(3)],lastRowID:3,hasMore:false),config:config())
        var calls = 0; var ticks: [TimeInterval] = [0,55]
        let count = try deliverPending(store:store,config:config(),clock:{ticks.removeFirst()}) { _, _ in calls += 1; return .accepted }
        try expect(count == 0 && calls == 0, "no first request when fewer than40 seconds remain")
        try expect(store.status(config:config()).pendingCount == 3 && store.status(config:config()).lastCapturedRowID == 3, "budget exhaustion leaves pending payloads and capture cursor intact")
        var now: TimeInterval = 0
        let completed = try deliverPending(store:store,config:config(),clock:{now}) { _, _ in now += 30; return .accepted }
        try expect(completed == 2 && now == 60, "fakeclock stops before starting request outside90-second budget")
        let remaining = try store.pending(config:config())
        try expect(remaining.map(\.guid) == ["fixture-guid-3"] && remaining[0].attempts == 0, "unclaimed row remains pending without a failed-attempt mutation")
        try expect(store.status(config:config()).lastCapturedRowID == 3 && store.status(config:config()).acknowledgedCount == 2, "bounded delivery never rolls back or loses capture progress")
    }
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages:(1...5).map{message(Int64($0))},lastRowID:5,hasMore:false),config:config())
        var calls = 0
        let count = try deliverPending(store:store,config:config(),clock:{0}) { _, _ in calls += 1; return .accepted }
        try expect(count == 3 && calls == 3 && store.status(config:config()).pendingCount == 2, "delivery is capped at3 requests even when time remains")
        try expectError("overlarge count budget refused") { _ = try deliverPending(store:store,config:config(),maxMessages:4) {_,_ in .accepted} }
        try expectError("overlarge elapsed budget refused") { _ = try deliverPending(store:store,config:config(),elapsedBudget:91) {_,_ in .accepted} }
    }
}
func makeSource(_ root: URL) throws -> (MessageSource, SQLDatabase) {
    let path = root.appendingPathComponent("synthetic-messages.sqlite")
    let fd = open(path.path, O_RDWR | O_CREAT | O_EXCL, 0o600); guard fd >= 0 else { throw FixtureFailure(label: "synthetic source create") }; close(fd)
    let writer = try SQLDatabase(path: path.path, readOnly: false)
    try writer.execute("create table handle (id text)"); for sender in ["MobileMoney", "friend", "GCB", "MobileMoney-personal"] { try writer.execute("insert into handle values (?)", [.text(sender)]) }
    try writer.execute("create table message (guid text,text text,attributedBody blob,date integer,handle_id integer,service text,is_from_me integer)")
    let ns = Int64(epoch.timeIntervalSinceReferenceDate * 1_000_000_000)
    let rows: [(String, Int64, Int64, String, Int64)] = [("old", ns-1_000_000_000,1,"SMS",0),("personal",ns+1_000_000_000,2,"SMS",0),("rcs",ns+1_000_000_000,1,"RCS",0),("imessage",ns+1_000_000_000,1,"iMessage",0),("outgoing",ns+1_000_000_000,1,"SMS",1),("delayed",ns-9_000_000_000_000,1,"SMS",0),("eligible",ns+1_000_000_000,1,"SMS",0),("unknown",ns+1_000_000_000,3,"SMS",0),("prefix",ns+1_000_000_000,4,"SMS",0),("otp",ns+1_000_000_000,1,"SMS",0)]
    for row in rows { try writer.execute("insert into message values (?,?,null,?,?,?,?)", [.text(row.0), .text(row.0 == "otp" ? "Fixture OTP balance" : "Fixture GHS 1"), .integer(row.1), .integer(row.2), .text(row.3), .integer(row.4)]) }
    return (try MessageSource(path: path.path), writer)
}
func testSourceAndPrivacy() throws {
    let root = try directory(); defer { try? FileManager.default.removeItem(at: root) }
    let (source, _) = try makeSource(root)
    let store = try OutboxStore(directory: root); try store.initialize(config: config(), maxRowID: 1, at: epoch)
    try expect(source.highWaterMark() == 10, "high-water read metadata only")
    let baseline = try store.baseline(config: config())
    let first = try source.captureBatch(baseline: baseline, config: config())
    try expect(first.messages.map(\.guid) == ["eligible", "otp"] && first.lastRowID == 10 && first.scannedRowCount == 9, "header scan excludes personal/old/RCS/iMessage/outgoing/unknown without reading their bodies")
    try store.capture(first, config: config())
    try expect(!first.hasMore && store.status(config: config()).lastCapturedRowID == 10 && store.status(config: config()).pendingCount == 1, "capture filters credential content while preserving header progress")
    let configRoot = root.appendingPathComponent("config-fixture"); try saveNewConfig(config(), directory: configRoot)
    try expect(loadConfig(configRoot).senders == ["mobilemoney"], "private config round trip")
    try expectError("config never overwritten") { try saveNewConfig(config(), directory: configRoot) }
    try FileManager.default.setAttributes([.posixPermissions:0o644], ofItemAtPath:configRoot.appendingPathComponent("config.json").path)
    try expectError("public-readable config refused") { _ = try loadConfig(configRoot) }
    let corrupt = root.appendingPathComponent("corrupt"); try ensurePrivateDirectory(corrupt)
    let bad = corrupt.appendingPathComponent("outbox.sqlite"); try Data("synthetic corrupt database".utf8).write(to:bad); try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:bad.path)
    try expectError("corrupt outbox not reset") { _ = try OutboxStore(directory:corrupt) }
}
@main struct CollectorTests {
    static func main() {
        do { try testSelection(); try testTransactionsAndRetention(); try testDelivery(); try testDeliveryBudget(); try testSourceAndPrivacy(); try testDurableReceipts(); try testSourceQuarantine(); print("PASS: \(assertions) synthetic collector assertions; no real Messages, credentials or network requests used.") }
        catch let error as FixtureFailure { fputs("FAIL: \(error.label)\n",stderr); exit(1) }
        catch let error as CollectorError { fputs("FAIL: synthetic operation: \(error.description)\n",stderr); exit(1) }
        catch { fputs("FAIL: synthetic fixture operation\n",stderr); exit(1) }
    }
}
