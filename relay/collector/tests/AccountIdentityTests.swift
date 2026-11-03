import Foundation
import Darwin

private struct TestFailure: Error { let label: String }
private var assertions = 0
private func expect(_ value: @autoclosure () throws -> Bool, _ label: String) throws { assertions += 1; if try !value() { throw TestFailure(label: label) } }
private func rejected(_ label: String, _ block: () throws -> Void) throws {
    do { try block() } catch { assertions += 1; return }; throw TestFailure(label: label)
}
private let key = "alf_" + String(repeating: "x", count: 24)
private let identity = CollectorAccountIdentity(ownerId: "11111111-1111-4111-8111-111111111111", preferredName: "Fictional reviewer", email: "reviewer@example.invalid")
private func config(_ other: Bool = false) -> CollectorConfig { CollectorConfig(version: 1, key: other ? "alf_" + String(repeating: "y", count: 24) : key, senderAllowlist: ["mobilemoney"]) }
private func binding() -> CollectorAccountBinding { CollectorAccountBinding(version: 1, identity: identity, credentialHash: config().credentialHash, confirmedAt: stamp()) }
private func temporary(_ run: (URL) throws -> Void) throws {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-identity-fixture-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: path) }
    try ensurePrivateDirectory(path); try run(path)
}
private func response(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> Data {
    var value: [String: Any] = ["ok": true, "identityProtocol": 1, "account": ["ownerId": identity.ownerId, "preferredName": identity.preferredName, "email": identity.email]]
    change(&value); return try JSONSerialization.data(withJSONObject: value)
}
private func testIdentityResponse() throws {
    let good = try response()
    try expect(decodeAccountIdentity(status: 200, data: good, networkError: false) == identity, "strict identity response")
    for status in [201, 301, 302, 400, 401, 403, 429, 500, 503] { try rejected("non-200 identity rejected") { _ = try decodeAccountIdentity(status: status, data: good, networkError: false) } }
    try rejected("network error rejected") { _ = try decodeAccountIdentity(status: 200, data: good, networkError: true) }
    for payload in [Data(), Data(repeating: 32, count: 8193), Data("{}".utf8), Data("{\"ok\":1}".utf8)] {
        try rejected("incomplete/oversized identity rejected") { _ = try decodeAccountIdentity(status: 200, data: payload, networkError: false) }
    }
    for update: ([String: Any], String) in [(["ok": false], "false success"), (["ok": 1], "numeric success"), (["identityProtocol": 2], "unknown protocol"), (["account": ["ownerId": "other"]], "malformed owner")] {
        let payload = try response { value in for (key, item) in update.0 { value[key] = item } }
        try rejected(update.1) { _ = try decodeAccountIdentity(status: 200, data: payload, networkError: false) }
    }
    for name in ["", String(repeating: "x", count: 81), "Unsafe\u{001b}[31m", "Unsafe\u{202e}name"] {
        try rejected("unsafe displayed identity rejected") { try CollectorAccountIdentity(ownerId: identity.ownerId, preferredName: name, email: identity.email).validate() }
    }
    for email in ["invalid", "bad\n@example.invalid", "bad\u{202e}@example.invalid", "<script>@example.invalid", String(repeating: "x", count: 255) + "@example.invalid"] {
        try rejected("unsafe displayed email rejected") { try CollectorAccountIdentity(ownerId: identity.ownerId, preferredName: identity.preferredName, email: email).validate() }
    }
}
private func testExplicitConfirmation() throws {
    var checks = 0, confirms = 0
    try rejected("cancelled confirmation stays disconnected") {
        _ = try confirmedAccount(key: key, lookup: { received in try expect(received == key, "key supplied only to injected lookup"); checks += 1; return identity }, confirm: { shown in try expect(shown == identity, "actual verified account shown"); confirms += 1; return false })
    }
    try expect(checks == 1 && confirms == 1, "no retry or silent confirmation")
    try expect(confirmedAccount(key: key, lookup: { _ in identity }, confirm: { $0.email == identity.email }) == identity, "explicit account confirmation")
    var shown = false
    try rejected("failed lookup cannot ask for confirmation") {
        _ = try confirmedAccount(key: key, lookup: { _ in throw CollectorError("Fixture lookup failed") }, confirm: { _ in shown = true; return true })
    }
    try expect(!shown, "no unverified identity shown")
}
private func testPrivateBinding() throws {
    try temporary { directory in
        var lookedUp = false
        try rejected("old unverified config blocked before lookup") { _ = try verifiedAccountBinding(config: config(), directory: directory, lookup: { _ in lookedUp = true; return identity }) }
        try expect(!lookedUp, "missing confirmation never reaches recipient")
        try saveNewAccountBinding(binding(), directory: directory, config: config())
        let path = directory.appendingPathComponent("account.json")
        var info = stat(); try expect(lstat(path.path, &info) == 0 && info.st_mode & 0o777 == 0o600 && info.st_uid == getuid(), "private owned account binding")
        let raw = try readPrivate(path)
        try expect(!String(decoding: raw, as: UTF8.self).contains(key), "binding contains no key")
        try expect(loadAccountBinding(directory: directory, config: config()).identity == identity, "binding round trip")
        try rejected("binding cannot be overwritten") { try saveNewAccountBinding(binding(), directory: directory, config: config()) }
        try expect(readPrivate(path) == raw, "existing binding preserved")
        try rejected("changed key cannot reuse binding") { _ = try verifiedAccountBinding(config: config(true), directory: directory, lookup: { _ in lookedUp = true; return identity }) }
        try expect(!lookedUp, "wrong key fails before recipient")
        let result = try verifiedAccountBinding(config: config(), directory: directory, lookup: { received in try expect(received == key, "verified key used for fresh read"); return identity })
        try expect(result.identity.ownerId == identity.ownerId, "same owner verified afresh")
        let foreign = CollectorAccountIdentity(ownerId: "22222222-2222-4222-8222-222222222222", preferredName: "Another fictional account", email: "other@example.invalid")
        try rejected("changed remote owner blocks delivery") { _ = try verifiedAccountBinding(config: config(), directory: directory, lookup: { _ in foreign }) }
        try expect(readPrivate(path) == raw, "owner mismatch never migrates binding")
        try rejected("revoked/offline key blocks live operations") { _ = try verifiedAccountBinding(config: config(), directory: directory, lookup: { _ in throw CollectorError("Fixture rejected") }) }
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: path.path)
        try rejected("public-readable binding refused") { _ = try loadAccountBinding(directory: directory, config: config()) }
    }
    try temporary { directory in
        let target = directory.appendingPathComponent("target")
        try Data("fictional private target".utf8).write(to: target)
        let linked = directory.appendingPathComponent("account.json")
        try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: target)
        try rejected("symlink binding not read") { _ = try loadAccountBinding(directory: directory, config: config()) }
        try rejected("symlink binding not overwritten") { try saveNewAccountBinding(binding(), directory: directory, config: config()) }
        try expect(String(decoding: Data(contentsOf: target), as: UTF8.self) == "fictional private target", "symlink target unchanged")
    }
}
@main struct AccountIdentityTests {
    static func main() {
        do { try testIdentityResponse(); try testExplicitConfirmation(); try testPrivateBinding(); print("PASS: \(assertions) synthetic account identity assertions; no real key, Messages access or network used.") }
        catch let failure as TestFailure { fputs("FAIL: \(failure.label)\n", stderr); exit(1) }
        catch { fputs("FAIL: synthetic identity fixture operation\n", stderr); exit(1) }
    }
}
