import Foundation
import Darwin
import SQLite3

private var checks = 0
private struct SetupFailure: Error { let message: String }
private func check(_ value: @autoclosure () throws -> Bool, _ message: String) throws {
    checks += 1; if try !value() { throw SetupFailure(message: message) }
}
private func rejects(_ message: String, _ action: () throws -> Void) throws {
    do { try action() } catch { checks += 1; return }
    throw SetupFailure(message: message)
}
private let account = CollectorAccountIdentity(ownerId: "11111111-1111-4111-8111-111111111111", preferredName: "Fictional User", email: "fictional@example.invalid")
private let other = CollectorAccountIdentity(ownerId: "22222222-2222-4222-8222-222222222222", preferredName: "Other Sample", email: "other@example.invalid")
private let beginning = Date(timeIntervalSince1970: 1_794_000_000)
private final class FakeService: CollectorBackgroundService {
    var status = CollectorServiceStatus.notRegistered
    var registered = 0, unregistered = 0
    var registrationResult = CollectorServiceStatus.enabled
    var registrationFails = false, unregisterFails = false
    var beforeUnregister: (() throws -> Void)?
    func register() throws {
        registered += 1
        if registrationFails { throw SetupFailure(message: "synthetic registration unavailable") }
        status = registrationResult
    }
    func unregister() throws {
        unregistered += 1; try beforeUnregister?()
        if unregisterFails { throw SetupFailure(message: "synthetic unregister unavailable") }
        status = .notRegistered
    }
}
private final class Fixture {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-setup-fixture-" + UUID().uuidString).resolvingSymlinksInPath()
    let service = FakeService()
    let config = CollectorConfig(version: 1, key: "alf_" + String(repeating: "x", count: 24), senderAllowlist: ["mobilemoney"])
    var time = beginning, identity = account, setupReady = true, validApp = true, headersAvailable = true
    var lookups = 0, headerReads = 0, guards = 0
    var highWater: Int64 = 40
    lazy var coordinator = CollectorSetupCoordinator(directory: directory, service: service,
        validateApp: { [unowned self] in self.guards += 1; if !self.validApp { throw SetupFailure(message: "synthetic scope failure") } },
        lookup: { [unowned self] _ in self.lookups += 1; return CollectorAccountCheck(identity: self.identity, setupReady: self.setupReady) },
        readMessageHeaders: { [unowned self] in self.headerReads += 1; if !self.headersAvailable { throw SetupFailure(message: "synthetic access unavailable") }; return self.highWater },
        clock: { [unowned self] in self.time })
    func connect() throws { try coordinator.connect(key: config.key, providers: config.senders, confirm: { $0 == account }) }
    func binding() throws -> CollectorAccountBinding { try loadAccountBinding(directory: directory, config: config) }
    func started() throws { try connect(); _ = try coordinator.checkMessagesAccess(); _ = try coordinator.start(confirmedIdentity: account, consent: true) }
    func cleanup() { try? FileManager.default.removeItem(at: directory) }
}
private func fixture(_ body: (Fixture) throws -> Void) throws { let value = Fixture(); defer { value.cleanup() }; try body(value) }

private func testInactiveAndConnection() throws {
    try fixture { f in
        let initial = try f.coordinator.snapshot()
        try check(initial.identity == nil && initial.service == .notRegistered && !initial.explicitlyEnabled, "fresh app opens inactive")
        try check(!pathExists(f.directory), "opening fresh setup creates no configuration or baseline")
        try check(f.lookups == 0 && f.headerReads == 0 && f.service.registered == 0, "opening setup has no network, Messages or registration")
        try rejects("provider scope must be explicit before account lookup") { try f.coordinator.connect(key: f.config.key, providers: [], confirm: { _ in true }) }
        try check(f.lookups == 0, "invalid scope never checks key remotely")
        try rejects("account confirmation defaults to cancellation") { try f.coordinator.connect(key: f.config.key, providers: f.config.senders, confirm: { _ in false }) }
        try check(!pathExists(f.directory.appendingPathComponent("config.json")), "cancel saves no key")
        try f.connect()
        let state = try f.coordinator.snapshot()
        try check(state.identity == account && state.providers == ["mobilemoney"], "confirmed account and exact providers saved")
        try check(f.headerReads == 0 && f.service.registered == 0, "connecting does not read Messages or start service")
        try check(!pathExists(f.directory.appendingPathComponent("outbox.sqlite")), "connecting creates no collection window")
        var info = stat(); _ = lstat(f.directory.appendingPathComponent("config.json").path, &info)
        try check(info.st_mode & 0o777 == 0o600, "saved key is private")
        try rejects("existing connection cannot be overwritten") { try f.coordinator.connect(key: "alf_" + String(repeating: "y", count: 24), providers: ["hubtel"], confirm: { _ in true }) }
        try check(loadConfig(f.directory).credentialHash == f.config.credentialHash, "rejected replacement preserves original key")
    }
    try fixture { f in
        f.validApp = false
        try rejects("altered app scope fails before connection") { try f.connect() }
        try check(!pathExists(f.directory) && f.lookups == 0, "scope rejection has no state/network effect")
    }
    try fixture { f in
        try saveNewConfig(f.config, directory: f.directory)
        try check(f.coordinator.snapshot().needsSavedAccountConfirmation, "partial private setup remains recoverable but inactive")
        try f.coordinator.confirmSavedAccount(confirm: { $0 == account })
        try check(f.coordinator.snapshot().identity == account && f.headerReads == 0, "explicit confirmation completes partial save without Messages")
        f.identity = other
        try rejects("saved owner cannot be replaced") { try f.coordinator.confirmSavedAccount(confirm: { _ in true }) }
        try check(f.binding().identity == account, "changed remote account never replaces binding")
    }
}
private func testReadinessAndFreshAccess() throws {
    try fixture { f in
        try f.connect(); f.setupReady = false
        try rejects("backend not ready blocks access check") { _ = try f.coordinator.checkMessagesAccess() }
        try check(f.headerReads == 0 && f.coordinator.accessCheck == nil, "missing backend capability never reads Messages")
        f.setupReady = true; _ = try f.coordinator.checkMessagesAccess()
        f.setupReady = false
        try rejects("Start rechecks backend capability") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(f.headerReads == 1 && f.service.registered == 0, "stale ready flag cannot start collection")
        try check(!pathExists(f.directory.appendingPathComponent("outbox.sqlite")), "blocked Start has no source window")
    }
    try fixture { f in
        try f.connect()
        try rejects("Start requires explicit access check") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try rejects("Start requires explicit consent") { _ = try f.coordinator.start(confirmedIdentity: account, consent: false) }
        try check(f.headerReads == 0 && f.service.registered == 0, "no implicit check or registration")
        f.headersAvailable = false
        try rejects("Messages denial stays a blocker") { _ = try f.coordinator.checkMessagesAccess() }
        try check(f.coordinator.accessCheck == nil, "failed access never marks ready")
        f.headersAvailable = true; _ = try f.coordinator.checkMessagesAccess()
        f.time = f.time.addingTimeInterval(301)
        try rejects("old access check expires") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        f.time = beginning; _ = try f.coordinator.checkMessagesAccess(); f.identity = other
        try rejects("remote owner change blocks Start") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(f.service.registered == 0, "account mismatch never registers")
    }
}
private func testStartPauseAndOriginalWindow() throws {
    try fixture { f in
        try f.started()
        let store = try OutboxStore(directory: f.directory)
        let original = try store.baseline(config: f.config)
        try check(original.initialRowID == 40 && original.initializedAt == stamp(beginning), "first Start explicitly establishes future-only window")
        try check(f.headerReads == 2 && f.service.registered == 1, "Start freshly checks headers and registers only once")
        try check(scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "valid explicit start permits scheduled work")
        let activationText = String(data: try readPrivate(f.directory.appendingPathComponent("activation.json")), encoding: .utf8)!
        try check(!activationText.contains(f.config.key) && !activationText.contains(account.email), "activation stores no key or account contact")
        let beforeLookups = f.lookups, beforeHeaders = f.headerReads
        let worker = try CollectorLock(directory: f.directory)
        f.service.beforeUnregister = {
            try check(!scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "Pause revokes before OS unregister")
        }
        try f.coordinator.pause()
        withExtendedLifetime(worker) {}
        try check(f.lookups == beforeLookups && f.headerReads == beforeHeaders, "Pause works offline without Messages access")
        try check(f.service.unregistered == 1 && f.service.status == .notRegistered, "Pause stops own service while worker lock is held")
        try check(store.baseline(config: f.config).initialRowID == original.initialRowID, "Pause preserves original fence")
        // Release the simulated worker before an explicit resume.
    }
    try fixture { f in
        try f.started(); try f.coordinator.pause()
        f.time = beginning.addingTimeInterval(120); f.highWater = 100
        _ = try f.coordinator.checkMessagesAccess(); _ = try f.coordinator.start(confirmedIdentity: account, consent: true)
        let base = try OutboxStore(directory: f.directory, readOnly: true).baseline(config: f.config)
        try check(base.initialRowID == 40 && base.initializedAt == stamp(beginning), "resume never replaces original baseline with current high-water")
    }
    try fixture { f in
        try f.started(); f.service.unregisterFails = true
        try rejects("unregister failure is reported") { try f.coordinator.pause() }
        try check(!scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "failed OS unregister still leaves durable collection gate off")
        try check(f.service.unregistered == 1, "Pause performs one unregister attempt")
    }
}
private func testRegistrationAndInterruptedSetup() throws {
    try fixture { f in
        try f.connect(); _ = try f.coordinator.checkMessagesAccess()
        f.service.registrationResult = .requiresApproval
        try check(f.coordinator.start(confirmedIdentity: account, consent: true) == .requiresApproval, "OS approval remains pending")
        try check(!scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "system approval alone cannot activate capture")
        f.service.status = .enabled
        try check(!scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "later system approval still requires explicit Start")
        _ = try f.coordinator.start(confirmedIdentity: account, consent: true)
        try check(scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "explicit return Start enables approved service")
        try check(f.service.registered == 1, "already enabled service is not redundantly registered")
    }
    try fixture { f in
        try f.connect(); _ = try f.coordinator.checkMessagesAccess(); f.service.registrationFails = true
        try rejects("registration failure stays inactive") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(!scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "failed registration keeps paused gate")
        let before = try OutboxStore(directory: f.directory, readOnly: true).baseline(config: f.config)
        f.service.registrationFails = false; f.highWater = 90
        _ = try f.coordinator.start(confirmedIdentity: account, consent: true)
        try check(OutboxStore(directory: f.directory, readOnly: true).baseline(config: f.config).initialRowID == before.initialRowID, "registration retry preserves first window")
    }
    try fixture { f in
        try f.connect(); _ = try OutboxStore(directory: f.directory)
        try check(f.coordinator.snapshot().identity == account && f.coordinator.snapshot().outbox == nil, "known empty v3 store remains usable after interrupted first Start")
        _ = try f.coordinator.checkMessagesAccess(); _ = try f.coordinator.start(confirmedIdentity: account, consent: true)
        try check(scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "explicit Start safely finishes empty setup")
    }
    try fixture { f in
        try f.connect(); let store = try OutboxStore(directory: f.directory)
        try store.db.execute("insert into seen values('synthetic-orphan',?,'synthetic',null)", [.text(String(repeating: "a", count: 64))])
        try rejects("nonempty orphan state cannot masquerade as first Start") { _ = try f.coordinator.snapshot() }
        _ = try f.coordinator.checkMessagesAccess()
        try rejects("Start cannot reset orphan state") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(store.db.scalarInt("select count(*) from seen") == 1 && f.service.registered == 0, "orphan evidence kept without activation")
    }
    try fixture { f in
        try f.connect(); let store = try OutboxStore(directory: f.directory)
        try store.db.execute("create table held_review_audit(token text primary key)")
        try rejects("retained review history is never treated as fresh setup") { _ = try f.coordinator.snapshot() }
    }
    try fixture { f in
        try f.started()
        try Data("{}".utf8).write(to: f.directory.appendingPathComponent("activation.json"))
        try rejects("corrupt activation never authorizes scheduled work") { _ = try scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()) }
        try rejects("explicit Start cannot silently repair corrupt consent") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(String(data: readPrivate(f.directory.appendingPathComponent("activation.json")), encoding: .utf8) == "{}", "corrupt choice kept for review")
    }
}
private func testPerSendPauseAndHeaderOnlyCheck() throws {
    try fixture { f in
        try f.started(); let store = try OutboxStore(directory: f.directory)
        let messages = (1...2).map { n in CapturedMessage(rowID: Int64(40+n), guid: "synthetic-setup-\(n)", sender: "mobilemoney", body: "Fictional GHS 10 payment", receivedAt: stamp(beginning.addingTimeInterval(Double(n))), service: "SMS") }
        _ = try store.capture(CaptureBatch(messages: messages, lastRowID: 42, hasMore: false), config: f.config)
        let worker = try CollectorLock(directory: f.directory)
        var sent = 0
        let accepted = try deliverPending(store: store, config: f.config,
            maySend: { try scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()) },
            transport: { _, _ in sent += 1; try! f.coordinator.pause(); return .accepted })
        withExtendedLifetime(worker) {}
        try check(sent == 1 && accepted == 1, "Pause before next send stops remaining batch")
        try check(store.status(config: f.config).pendingCount == 1 && store.status(config: f.config).acknowledgedCount == 1, "in-flight accepted receipt retained; later payload kept for resume")
    }
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-header-check-" + UUID().uuidString)
    try ensurePrivateDirectory(root); defer { try? FileManager.default.removeItem(at: root) }
    let path = root.appendingPathComponent("fixture.sqlite")
    guard FileManager.default.createFile(atPath: path.path, contents: Data(), attributes: [.posixPermissions: 0o600]) else { throw SetupFailure(message: "fixture create") }
    let db = try SQLDatabase(path: path.path, readOnly: false)
    try db.execute("create table handle(id text)")
    try db.execute("create table message(guid text,date integer,service text,is_from_me integer,handle_id integer,text text,attributedBody blob)")
    try db.execute("insert into message values('synthetic',0,'SMS',0,1,null,x'ffffff')")
    try check(MessageSource(path: path.path).checkHeaderAccess() == 1, "header check succeeds without decoding invalid body bytes")
    try check(db.scalarInt("select count(*) from message") == 1, "access check changes no source rows")
}
private func testCapabilityProtocol() throws {
    let identity = try JSONSerialization.jsonObject(with: JSONEncoder().encode(account))
    for (protocolValue, ready, expected) in [(1, true, true), (1, false, false), (2, true, false)] {
        let body = try JSONSerialization.data(withJSONObject: ["ok": true, "identityProtocol": 1, "account": identity, "setupProtocol": protocolValue, "setupReady": ready])
        try check(decodeCollectorAccountCheck(status: 200, data: body, networkError: false).setupReady == expected, "setup capability version and flag are both required")
    }
    let old = try JSONSerialization.data(withJSONObject: ["ok": true, "identityProtocol": 1, "account": identity])
    try check(!decodeCollectorAccountCheck(status: 200, data: old, networkError: false).setupReady, "old identity-only response cannot permit setup")
    try check(decodeAccountIdentity(status: 200, data: old, networkError: false) == account, "explicit legacy identity checks retain compatibility")
}
private func testUnknownRegistrationAndBundleValidation() throws {
    try check(collectorServiceStatus(lookup: .notFound, bundledAgentValid: true) == .registrationUnknown, "OS notFound does not imply a missing bundled item")
    try check(collectorServiceStatus(lookup: .unknown, bundledAgentValid: true) == .registrationUnknown, "unknown OS status never implies active registration")
    try check(collectorServiceStatus(lookup: .enabled, bundledAgentValid: false) == .unavailable, "missing or invalid resources remain unavailable even if OS reports enabled")
    try check(collectorServiceStatus(lookup: .notRegistered, bundledAgentValid: true) == .notRegistered, "known unregistered state remains distinct")
    for input in ["", " \n\t "] {
        do { _ = try collectorConnectionKey(input); throw SetupFailure(message: "empty key accepted") }
        catch let error as CollectorError { try check(error.description == "Paste your Alfred connection key before connecting.", "blank key has clear feedback") }
    }
    try check(collectorConnectionKey("  synthetic-key\n") == "synthetic-key", "nonblank input is trimmed without retaining UI contents")
    let bundle = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-agent-resource-fixture-" + UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: bundle) }
    let agents = bundle.appendingPathComponent("Contents/Library/LaunchAgents", isDirectory: true)
    let macOS = bundle.appendingPathComponent("Contents/MacOS", isDirectory: true)
    try FileManager.default.createDirectory(at: agents, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: macOS, withIntermediateDirectories: true)
    let executable = macOS.appendingPathComponent("AlfredCollector")
    try Data("fixture only; never execute".utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
    let plist = agents.appendingPathComponent(collectorAgentPlistName)
    var dictionary: [String: Any] = ["Label": "com.hansopoku.alfred.collector.agent", "BundleProgram": "Contents/MacOS/AlfredCollector",
        "ProgramArguments": ["AlfredCollector", "--scheduled-run"], "RunAtLoad": true, "StartInterval": 60, "ProcessType": "Background"]
    func save() throws { try PropertyListSerialization.data(fromPropertyList: dictionary, format: .xml, options: 0).write(to: plist) }
    try rejects("missing agent is unavailable") { try requireCollectorBundledAgent(at: bundle) }
    try save(); try requireCollectorBundledAgent(at: bundle)
    try check(true, "exact bundled resources validate without any service operation")
    dictionary["ProgramArguments"] = ["AlfredCollector", "--run"]; try save()
    try rejects("unguarded manual worker cannot replace scheduled agent") { try requireCollectorBundledAgent(at: bundle) }
    dictionary["ProgramArguments"] = ["AlfredCollector", "--scheduled-run"]; try save()
    let target = agents.appendingPathComponent("fixture-agent.plist")
    try FileManager.default.moveItem(at: plist, to: target)
    try FileManager.default.createSymbolicLink(at: plist, withDestinationURL: target)
    try rejects("symlinked agent is not an exact bundled resource") { try requireCollectorBundledAgent(at: bundle) }
    try fixture { f in
        f.service.status = .registrationUnknown
        let state = try f.coordinator.snapshot()
        try check(state.service == .registrationUnknown && !state.explicitlyEnabled && f.service.registered == 0, "opening unknown registration stays inactive and never registers")
        try f.connect()
        try rejects("unknown status still requires a fresh access check") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(f.service.registered == 0 && f.headerReads == 0, "unknown status cannot bypass setup gates")
        _ = try f.coordinator.checkMessagesAccess()
        try check(f.coordinator.start(confirmedIdentity: account, consent: true) == .enabled, "explicit Start can attempt normal registration after all checks")
        try check(f.service.registered == 1, "unknown status performs exactly one registration attempt")
        f.service.status = .registrationUnknown; f.service.unregisterFails = true
        try rejects("unknown OS status still reports unregister failure") { try f.coordinator.pause() }
        try check(f.service.unregistered == 1 && !scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "Pause durably revokes before unregistering an unknown service")
    }
    try fixture { f in
        try f.connect(); _ = try f.coordinator.checkMessagesAccess()
        f.service.status = .registrationUnknown; f.service.registrationFails = true
        try rejects("unknown status registration error remains reported") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(f.service.registered == 1 && !scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "failed unknown registration remains paused without retry")
    }
    try fixture { f in
        try f.connect(); _ = try f.coordinator.checkMessagesAccess()
        f.service.status = .registrationUnknown; f.service.registrationResult = .registrationUnknown
        try check(f.coordinator.start(confirmedIdentity: account, consent: true) == .registrationUnknown, "unconfirmed registration result is not upgraded to enabled")
        try check(!scheduledCollectorRunAllowed(directory: f.directory, config: f.config, binding: f.binding()), "unconfirmed result retains disabled durable consent")
    }
    try fixture { f in
        try f.connect(); _ = try f.coordinator.checkMessagesAccess(); f.service.status = .unavailable
        try rejects("invalid bundled resources continue to block Start") { _ = try f.coordinator.start(confirmedIdentity: account, consent: true) }
        try check(f.service.registered == 0 && !pathExists(f.directory.appendingPathComponent("outbox.sqlite")), "unavailable resources create no collection window or registration")
    }
}
@main private struct CollectorSetupTests {
    static func main() throws {
        try testInactiveAndConnection(); try testReadinessAndFreshAccess(); try testStartPauseAndOriginalWindow()
        try testRegistrationAndInterruptedSetup(); try testPerSendPauseAndHeaderOnlyCheck(); try testCapabilityProtocol(); try testUnknownRegistrationAndBundleValidation()
        print("PASS: \(checks) synthetic native setup assertions; no real Messages, HTTP, app launch, credentials or service registration.")
    }
}
