import Foundation
import SQLite3
import Darwin

struct TestFailure: Error { let name: String }
var assertions = 0
func expect(_ condition: @autoclosure () throws -> Bool, _ name: String) throws {
    assertions += 1
    if try !condition() { throw TestFailure(name: name) }
}
func expectFailure(_ name: String, _ operation: () throws -> Void) throws {
    do { try operation() } catch { assertions += 1; return }
    throw TestFailure(name: name)
}
let fixtureStart = Date(timeIntervalSince1970: 1_794_000_000)
func config(_ senders: [String] = ["mobilemoney"]) -> Config {
    Config(version: 1, key: "alf_" + String(repeating: "x", count: 24), senderAllowlist: senders)
}
func state(_ row: Int64 = 0, _ scope: Config = config()) -> State {
    State(version: 1, lastRowID: row, initializedAt: timestamp(fixtureStart), senderAllowlist: scope.senders,
          credentialFingerprint: scope.credentialFingerprint, acceptedCount: 0, lastAcceptedAt: nil)
}
func text(_ row: Int64, _ body: String?, sender: String = "MobileMoney", service: String = "SMS") -> Text {
    Text(rowid: row, body: body, sender: sender, receivedAt: fixtureStart.addingTimeInterval(1), service: service)
}
func temporaryDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-synthetic-" + UUID().uuidString).resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    return root
}
func writePrivate(_ data: Data, _ url: URL) throws {
    try data.write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
func makeDatabase(_ url: URL) throws {
    var db: OpaquePointer?
    guard sqlite3_open(url.path, &db) == SQLITE_OK else { throw TestFailure(name: "fixture database open") }
    defer { sqlite3_close(db) }
    let ns = Int64(fixtureStart.timeIntervalSinceReferenceDate * 1_000_000_000)
    let sql = """
    create table handle (id text); insert into handle values ('MobileMoney'), ('friend'), ('GCB'), ('MobileMoney-personal');
    create table message (text text, attributedBody blob, date integer, handle_id integer, service text, is_from_me integer);
    insert into message values ('fixture old GHS 1',null,\(ns-1_000_000_000),1,'SMS',0);
    insert into message values ('fixture personal GHS 2',null,\(ns+1_000_000_000),2,'SMS',0);
    insert into message values ('fixture RCS GHS 3',null,\(ns+1_000_000_000),1,'RCS',0);
    insert into message values ('fixture iMessage GHS 4',null,\(ns+1_000_000_000),1,'iMessage',0);
    insert into message values ('fixture outgoing GHS 5',null,\(ns+1_000_000_000),1,'SMS',1);
    insert into message values ('fixture delayed history GHS 6',null,\(ns-3_600_000_000_000),1,'SMS',0);
    insert into message values ('fixture alert GHS 7',null,\(ns+1_000_000_000),1,'SMS',0);
    insert into message values ('fixture unknown GHS 8',null,\(ns+1_000_000_000),3,'SMS',0);
    insert into message values ('fixture prefix GHS 9',null,\(ns+1_000_000_000),4,'SMS',0);
    insert into message values ('fixture OTP GHS 10',null,\(ns+1_000_000_000),1,'SMS',0);
    """
    guard sqlite3_exec(db, sql, nil, nil, nil) == SQLITE_OK else { throw TestFailure(name: "fixture database setup") }
}
func testScope() throws {
    try config(["MOBILEMONEY", " Hubtel "]).validate()
    for invalid in [[], ["gcb"], ["+233000000000"], ["friend"], ["mobilemoney", "MOBILEMONEY"]] {
        try expectFailure("configuration scope fails closed") { try config(invalid).validate() }
    }
    let allowed = text(1, "Fixture payment GHS 25")
    try expect(shouldSend(allowed, config: config()), "provider alert accepted")
    for sender in ["friend", "mobilemoney-personal", "mobilemoney@example.com", "gcb"] {
        try expect(!shouldSend(text(2, "Fixture GHS 25", sender: sender), config: config()), "personal or unverified sender excluded")
    }
    for service in ["RCS", "iMessage", ""] {
        try expect(!shouldSend(text(3, "Fixture GHS 25", service: service), config: config()), "non-SMS excluded")
    }
    for body in ["Fixture OTP 123 GHS 25", "Fixture verification code 123 balance", "Fixture one-time password GHS 25", "Fixture PIN is 123 GHS 25", "Fixture PIN:123 balance", "Fixture security code balance", "Fixture passcode GHS 1", "Fixture ordinary provider greeting", "Fixture GHSfriend"] {
        try expect(!shouldSend(text(4, body), config: config()), "credentials and non-alerts excluded")
    }
    try expectFailure("missing body held") { _ = try shouldSend(text(5, nil), config: config()) }
}
func testDecodeAndResponses() throws {
    for bytes in [Data(), Data("NSString".utf8), Data("NSString12345".utf8) + Data([0x81,0xff]), Data("NSString12345".utf8) + Data([0x82,0xff,0xff,0xff,0xff])] {
        try expect(decodeAttributedBody(bytes) == nil, "truncated archive held")
    }
    let fixture = "Fixture GHS 10"
    let encoded = Data("NSString12345".utf8) + Data([UInt8(fixture.utf8.count)]) + Data(fixture.utf8)
    try expect(decodeAttributedBody(encoded) == fixture, "bounded archive decode")
    let good = Data("{\"ok\":true,\"found\":1,\"duplicates\":0,\"needsLabel\":0}".utf8)
    try expect(classifyResponse(status: 200, data: good, transportError: false) == .accepted, "valid acceptance")
    for status in [301,400,401,403,408,413,429,500,503] {
        try expect(classifyResponse(status: status, data: good, transportError: false) != .accepted, "every rejection retained")
    }
    for bad in ["{}", "{\"ok\":false}", "{\"ok\":1,\"found\":1,\"duplicates\":0,\"needsLabel\":0}", "{\"ok\":true,\"found\":true,\"duplicates\":0,\"needsLabel\":0}", "{\"ok\":true,\"found\":-1,\"duplicates\":0,\"needsLabel\":0}"] {
        try expect(classifyResponse(status: 200, data: Data(bad.utf8), transportError: false) != .accepted, "invalid success retained")
    }
    try expect(classifyResponse(status: 200, data: good, transportError: true) != .accepted, "transport failure retained")
    var redirectFollowed = true
    NoRedirects().urlSession(URLSession(configuration: .ephemeral), task: URLSession.shared.dataTask(with: endpoint),
                            willPerformHTTPRedirection: HTTPURLResponse(url: endpoint, statusCode: 302, httpVersion: nil, headerFields: nil)!,
                            newRequest: URLRequest(url: URL(string: "https://example.invalid/")!)) { redirectFollowed = $0 != nil }
    try expect(!redirectFollowed, "redirects never followed (no task resumed)")
}
func testProcessing() throws {
    let rows = [text(1,"Fixture OTP GHS 1"),text(2,"Fixture GHS 2"),text(3,"Fixture GHS 3"),text(4,"Fixture GHS 4")]
    var current = state(); var saved: [State] = []; var attempted: [Int64] = []
    try expectFailure("failed row held") {
        _ = try process(Batch(texts: rows, upperRowID: 4, hasMore: false), state: &current, config: config(), checkOnly: false,
                        persist: { saved.append($0) }, transmit: { attempted.append($0.rowid); return $0.rowid == 3 ? .retry("HTTP 403") : .accepted })
    }
    try expect(saved.last?.lastRowID == 2 && attempted == [2,3], "failure preserves durable cursor and stops later sends")
    try expect(saved.last?.acceptedCount == 1, "accepted counter persists")
    var undecoded = state(); var seen: [Int64] = []
    try expectFailure("decode error held") {
        _ = try process(Batch(texts: [text(1,"Fixture GHS 1"),text(2,nil),text(3,"Fixture GHS 3")], upperRowID: 3, hasMore: false), state: &undecoded, config: config(), checkOnly: false, persist: {_ in}, transmit: {seen.append($0.rowid); return .accepted})
    }
    try expect(undecoded.lastRowID == 1 && seen == [1], "decode failure never advances or sends later rows")
    var checked = state(); var sideEffect = false
    let counts = try process(Batch(texts: rows, upperRowID: 4, hasMore: false), state: &checked, config: config(), checkOnly: true, persist: {_ in sideEffect=true}, transmit: {_ in sideEffect=true; return .accepted})
    try expect(counts.accepted == 3 && !sideEffect && checked.lastRowID == 0, "check has no sends/persistence")
    var brokenWrite = state(); var sent: [Int64] = []
    try expectFailure("failed persistence stops processing") {
        _ = try process(Batch(texts: rows, upperRowID: 4, hasMore: false), state: &brokenWrite, config: config(), checkOnly: false, persist: {_ in throw TestFailure(name:"fixture write failure")}, transmit: {sent.append($0.rowid); return .accepted})
    }
    try expect(sent.isEmpty, "write failure prevents subsequent sends")
    var acceptedButUncommitted = state(); var acceptedSends: [Int64] = []; var durable = state()
    try expectFailure("persistence failure after acceptance stops later sends") {
        _ = try process(Batch(texts:[text(1,"Fixture GHS 1"),text(2,"Fixture GHS 2")],upperRowID:2,hasMore:false),
                        state:&acceptedButUncommitted,config:config(),checkOnly:false,
                        persist:{_ in throw TestFailure(name:"fixture durable write failure")},
                        transmit:{acceptedSends.append($0.rowid);return .accepted})
    }
    try expect(acceptedSends == [1] && durable.lastRowID == 0, "accepted but uncommitted row can retry; later row not sent")
    // Server duplicate acknowledgments count as acceptance on that safe retry.
    let duplicate = Data("{\"ok\":true,\"found\":0,\"duplicates\":1,\"needsLabel\":0}".utf8)
    _ = try process(Batch(texts:[text(1,"Fixture GHS 1")],upperRowID:1,hasMore:false),state:&durable,config:config(),checkOnly:false,
                    persist:{_ in},transmit:{_ in classifyResponse(status:200,data:duplicate,transportError:false)})
    try expect(durable.lastRowID == 1 && durable.acceptedCount == 1, "duplicate retry safely commits cursor")
}
func testDatabaseAndState() throws {
    let root = try temporaryDirectory(); defer { try? FileManager.default.removeItem(at: root) }
    let databaseURL = root.appendingPathComponent("fixture.db"); try makeDatabase(databaseURL)
    let db = try MessagesDatabase(path: databaseURL.path)
    try expect(db.maximumRowID() == 10, "baseline metadata only")
    var baseline = state(1)
    let batch = try db.readBatch(state: baseline, config: config())
    try expect(batch.texts.map(\.rowid) == [7,10], "SQL excludes personal/outgoing/RCS/iMessage/history/unknown provider bodies")
    let first = try db.readBatch(state: baseline, config: config(), limit: 1)
    try expect(first.hasMore && first.texts.map(\.rowid) == [7], "batch boundary retains later work")
    _ = try process(first, state: &baseline, config: config(), checkOnly: false, persist: {_ in}, transmit: {_ in .accepted})
    try expect(baseline.lastRowID == 7, "partial batch stops at last processed row")
    let next = try db.readBatch(state: baseline, config: config(), limit: 1)
    _ = try process(next, state: &baseline, config: config(), checkOnly: false, persist: {_ in}, transmit: {_ in .accepted})
    try expect(!next.hasMore && baseline.lastRowID == 10, "final batch advances safe watermark")
    try expectFailure("database rollback never resets cursor") { _ = try db.readBatch(state: state(11), config: config()) }
    var writer: OpaquePointer?
    guard sqlite3_open(databaseURL.path, &writer) == SQLITE_OK else { throw TestFailure(name:"fixture writer open") }
    defer { sqlite3_close(writer) }
    let ns = Int64(fixtureStart.timeIntervalSinceReferenceDate * 1_000_000_000) + 1_000_000_000
    guard sqlite3_exec(writer,"insert into message values (null,null,null,null,'iMessage',0); insert into message values (null,null,null,2,'SMS',0); insert into message values (null,null,null,null,null,null); insert into message values ('fixture future GHS 14',null,\(ns),1,'SMS',0);",nil,nil,nil) == SQLITE_OK else { throw TestFailure(name:"incomplete fixture insert") }
    let pending = try db.readBatch(state:baseline,config:config())
    try expect(pending.pendingMetadataRowID == 13 && pending.upperRowID == 12 && pending.texts.isEmpty, "only potentially eligible incomplete metadata holds later rows before body access")
    var pendingSent = false
    try expectFailure("metadata incompleteness visible") {
        _ = try process(pending,state:&baseline,config:config(),checkOnly:false,persist:{_ in},transmit:{_ in pendingSent=true;return .accepted})
    }
    try expect(baseline.lastRowID == 12 && !pendingSent, "known excluded incomplete rows do not stall; unknown metadata preserves cursor")
    guard sqlite3_exec(writer,"update message set text='fixture completed GHS 13',date=\(ns),handle_id=1,service='SMS',is_from_me=0 where ROWID=13;",nil,nil,nil) == SQLITE_OK else { throw TestFailure(name:"complete metadata fixture") }
    let recovered = try db.readBatch(state:baseline,config:config())
    try expect(recovered.pendingMetadataRowID == nil && recovered.texts.map(\.rowid) == [13,14], "completed metadata row retried without loss")
    guard sqlite3_exec(writer,"insert into message values ('fixture unknown direction GHS 15',null,\(ns),1,'SMS',null);",nil,nil,nil) == SQLITE_OK else { throw TestFailure(name:"unknown direction fixture") }
    let unknownDirection = try db.readBatch(state:state(14),config:config())
    try expect(unknownDirection.pendingMetadataRowID == 15 && unknownDirection.texts.isEmpty, "unknown direction held before body access")
    guard sqlite3_exec(writer,"update message set is_from_me=0,service='  ' where ROWID=15;",nil,nil,nil) == SQLITE_OK else { throw TestFailure(name:"whitespace service fixture") }
    try expect(db.readBatch(state:state(14),config:config()).pendingMetadataRowID == 15, "whitespace-only service held")
    guard sqlite3_exec(writer,"update message set service='SMS' where ROWID=15;",nil,nil,nil) == SQLITE_OK else { throw TestFailure(name:"metadata direction recovery fixture") }
    try expect(db.readBatch(state:state(14),config:config()).texts.map(\.rowid) == [15], "direction/service completion retried")
    let store = StateStore(root)
    try expectFailure("missing state never backfills") { _ = try store.load(config: config()) }
    try store.withLock {
        try expectFailure("concurrent operation blocked") { try store.withLock {} }
        try store.save(baseline)
    }
    try expect(store.load(config: config()).lastRowID == 12, "atomic state durable round trip")
    try expectFailure("scope changes fail closed") { _ = try store.load(config: config(["hubtel"])) }
    let changedKey = Config(version:1,key:"alf_" + String(repeating:"y",count:24),senderAllowlist:["mobilemoney"])
    try expectFailure("credential change invalidates prior acceptance metadata") { _ = try store.load(config: changedKey) }
    try writePrivate(Data("broken fixture".utf8), store.stateURL)
    try expectFailure("corrupt state never backfills") { _ = try store.load(config: config()) }
    try writePrivate(try JSONEncoder().encode(config()), root.appendingPathComponent("config.json"))
    try expect(loadConfig(at: root).senders == ["mobilemoney"], "private config read")
    try FileManager.default.setAttributes([.posixPermissions:0o644], ofItemAtPath:root.appendingPathComponent("config.json").path)
    try expectFailure("public-readable credential file rejected") { _ = try loadConfig(at:root) }
    let target = root.appendingPathComponent("untouched")
    try Data("fixture untouched".utf8).write(to: target)
    try FileManager.default.createSymbolicLink(atPath:root.appendingPathComponent("state.json.tmp").path, withDestinationPath:target.path)
    try expectFailure("atomic temp symlink rejected") { try store.save(baseline) }
    try expect(String(contentsOf:target,encoding:.utf8) == "fixture untouched", "symlink target preserved")
}
@main struct RelayTests {
    static func main() {
        do {
            try testScope(); try testDecodeAndResponses(); try testProcessing(); try testDatabaseAndState()
            print("PASS: \(assertions) synthetic relay assertions; no real Messages, credentials or network requests used.")
        } catch let error as TestFailure { fputs("FAIL: \(error.name)\n", stderr); exit(1) }
        catch { fputs("FAIL: synthetic fixture operation\n", stderr); exit(1) }
    }
}
