import Foundation
import Darwin
import SQLite3

let collectorAgentPlistName = "com.hansopoku.alfred.collector.agent.plist"
enum CollectorServiceStatus: Equatable { case notRegistered, enabled, requiresApproval, unavailable }
protocol CollectorBackgroundService: AnyObject {
    var status: CollectorServiceStatus { get }
    func register() throws
    func unregister() throws
}
private final class CollectorSetupControlLock {
    private var fd: Int32 = -1
    init(directory: URL) throws {
        fd = open(directory.appendingPathComponent("setup.lock").path, O_RDWR | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o600)
        var info = stat()
        guard fd >= 0, fstat(fd, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(), info.st_mode & 0o077 == 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            if fd >= 0 { close(fd) }; fd = -1
            throw CollectorError("Another setup action is finishing. Try again shortly.")
        }
    }
    deinit { if fd >= 0 { flock(fd, LOCK_UN); close(fd) } }
}

// This file contains no AppKit, Messages reader or ServiceManagement calls.
// Tests inject those boundaries and never run the app or register a service.
struct CollectorActivation: Codable {
    let version: Int
    let ownerId: String
    let credentialHash: String
    let senderScope: String
    let baselineAt: String
    let enabled: Bool
    let decidedAt: String
    func validate(config: CollectorConfig, binding: CollectorAccountBinding) throws {
        try binding.validate(config: config)
        guard version == 1, ownerId == binding.identity.ownerId,
              credentialHash == config.credentialHash, senderScope == scopeJSON(config),
              parseStamp(baselineAt) != nil, parseStamp(decidedAt) != nil else {
            throw CollectorError("This Mac's saved start choice does not match its connection. Collection stays off; review setup.")
        }
    }
}

func loadCollectorActivation(directory: URL, config: CollectorConfig, binding: CollectorAccountBinding) throws -> CollectorActivation? {
    let url = directory.appendingPathComponent("activation.json")
    guard try pathExists(url) else { return nil }
    let value: CollectorActivation
    do { value = try JSONDecoder().decode(CollectorActivation.self, from: readPrivate(url)) }
    catch { throw CollectorError("The saved start choice could not be checked. No automatic reset was performed.") }
    try value.validate(config: config, binding: binding); return value
}

private func saveCollectorActivation(_ value: CollectorActivation, directory: URL, config: CollectorConfig, binding: CollectorAccountBinding) throws {
    try value.validate(config: config, binding: binding); try ensurePrivateDirectory(directory)
    let destination = directory.appendingPathComponent("activation.json")
    if try pathExists(destination) { _ = try readPrivate(destination) }
    let temporary = directory.appendingPathComponent(".activation-" + UUID().uuidString + ".tmp")
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CollectorError("The start choice could not be saved. Collection was not enabled.") }
    defer { close(fd); unlink(temporary.path) }
    let bytes = try JSONEncoder().encode(value)
    try bytes.withUnsafeBytes { data in
        var offset = 0
        while offset < data.count {
            let count = write(fd, data.baseAddress!.advanced(by: offset), data.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw CollectorError("The start choice could not be saved. Collection was not enabled.") }
            offset += count
        }
    }
    guard fsync(fd) == 0, rename(temporary.path, destination.path) == 0 else {
        throw CollectorError("The start choice could not be saved. Review setup before continuing.")
    }
}

/** Must be checked again under CollectorLock immediately before capture/send. */
func scheduledCollectorRunAllowed(directory: URL, config: CollectorConfig, binding: CollectorAccountBinding) throws -> Bool {
    guard let activation = try loadCollectorActivation(directory: directory, config: config, binding: binding), activation.enabled else { return false }
    guard try pathExists(directory.appendingPathComponent("outbox.sqlite")) else { throw CollectorError("The saved collection window is missing. Collection stays off.") }
    let baseline = try OutboxStore(directory: directory, readOnly: true).baseline(config: config)
    guard activation.baselineAt == baseline.initializedAt else { throw CollectorError("The saved collection window changed. No backfill or reset was performed.") }
    return true
}

struct CollectorAccessCheck {
    let identity: CollectorAccountIdentity
    let credentialHash: String
    let senderScope: String
    let checkedAt: Date
}
struct CollectorSetupSnapshot {
    let identity: CollectorAccountIdentity?
    let providers: [String]
    let needsSavedAccountConfirmation: Bool
    let service: CollectorServiceStatus
    let explicitlyEnabled: Bool
    let accessCheckedAt: Date?
    let baselineAt: String?
    let outbox: OutboxStatus?
}
private func emptyUnstartedCollectorStore(_ store: OutboxStore) throws -> Bool {
    let baselines = try store.db.scalarInt("select count(*) from baseline")
    if baselines == 1 { return false }
    guard baselines == 0,
          try store.db.scalarInt("select count(*) from seen") == 0,
          try store.db.scalarInt("select count(*) from pending") == 0,
          try store.db.scalarInt("select count(*) from source_quarantine") == 0,
          try store.db.scalarInt("select count(*) from sqlite_master where type='table' and name in ('held_review_account','held_review_audit')") == 0,
          try store.db.scalarInt("select count(*) from totals where singleton=1 and failed_attempts=0") == 1,
          try store.db.scalarInt("select count(*) from totals") == 1 else {
        throw CollectorError("The saved collection window is incomplete and contains prior work. Nothing was reset.")
    }
    // Preparing schema-only queries checks required columns without selecting
    // pending text. A known empty v3 store can finish explicit setup after a
    // crash before its first baseline INSERT; a nonempty/corrupt store cannot.
    for sql in ["select singleton,version,initialized_at,initial_rowid,last_rowid,senders_json,credential_hash,last_capture_at,scan_has_more from baseline limit 0",
        "select guid,fingerprint,captured_at,acknowledged_at from seen limit 0",
        "select guid,sender,body,received_at,attempts,last_attempt_at,last_error_code,held_at from pending limit 0",
        "select source_rowid,guid_hash,reason,first_seen_at,last_checked_at,attempts from source_quarantine limit 0"] {
        let statement = try store.db.prepare(sql); sqlite3_finalize(statement)
    }
    return true
}

final class CollectorSetupCoordinator {
    let directory: URL
    private let service: CollectorBackgroundService
    private let validateApp: () throws -> Void
    private let lookup: (String) throws -> CollectorAccountCheck
    private let readMessageHeaders: () throws -> Int64
    private let clock: () -> Date
    private(set) var accessCheck: CollectorAccessCheck?
    init(directory: URL, service: CollectorBackgroundService,
         validateApp: @escaping () throws -> Void,
         lookup: @escaping (String) throws -> CollectorAccountCheck,
         readMessageHeaders: @escaping () throws -> Int64,
         clock: @escaping () -> Date = { Date() }) {
        self.directory = directory; self.service = service; self.validateApp = validateApp
        self.lookup = lookup; self.readMessageHeaders = readMessageHeaders; self.clock = clock
    }
    func snapshot() throws -> CollectorSetupSnapshot {
        try validateApp()
        guard try pathExists(directory) else {
            return CollectorSetupSnapshot(identity: nil, providers: [], needsSavedAccountConfirmation: false,
                service: service.status, explicitlyEnabled: false, accessCheckedAt: nil, baselineAt: nil, outbox: nil)
        }
        try ensurePrivateDirectory(directory)
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        guard try pathExists(directory.appendingPathComponent("config.json")) else {
            guard try !pathExists(directory.appendingPathComponent("account.json")), try !pathExists(directory.appendingPathComponent("outbox.sqlite")), try !pathExists(directory.appendingPathComponent("activation.json")) else {
                throw CollectorError("Saved setup is incomplete. Existing alerts were kept; no replacement connection was created.")
            }
            return CollectorSetupSnapshot(identity: nil, providers: [], needsSavedAccountConfirmation: false,
                service: service.status, explicitlyEnabled: false, accessCheckedAt: nil, baselineAt: nil, outbox: nil)
        }
        let config = try loadConfig(directory)
        guard try pathExists(directory.appendingPathComponent("account.json")) else {
            return CollectorSetupSnapshot(identity: nil, providers: config.senders, needsSavedAccountConfirmation: true,
                service: service.status, explicitlyEnabled: false, accessCheckedAt: nil, baselineAt: nil, outbox: nil)
        }
        let binding = try loadAccountBinding(directory: directory, config: config)
        let activation = try loadCollectorActivation(directory: directory, config: config, binding: binding)
        var status: OutboxStatus?
        if try pathExists(directory.appendingPathComponent("outbox.sqlite")) {
            let store = try OutboxStore(directory: directory, readOnly: true)
            if try emptyUnstartedCollectorStore(store) {
                guard activation == nil else { throw CollectorError("The original collection window is missing. Nothing was reset.") }
            } else { status = try store.status(config: config) }
        } else if activation != nil { throw CollectorError("The original collection window is missing. Nothing was reset.") }
        let checked = accessCheck.flatMap { value in
            value.identity.ownerId == binding.identity.ownerId && value.credentialHash == config.credentialHash && value.senderScope == scopeJSON(config) ? value : nil
        }
        return CollectorSetupSnapshot(identity: checked?.identity ?? binding.identity, providers: config.senders,
            needsSavedAccountConfirmation: false, service: service.status,
            explicitlyEnabled: activation?.enabled == true && activation?.baselineAt == status?.initializedAt,
            accessCheckedAt: checked?.checkedAt, baselineAt: status?.initializedAt, outbox: status)
    }
    func connect(key: String, providers: [String], confirm: (CollectorAccountIdentity) throws -> Bool) throws {
        try validateApp()
        let config = CollectorConfig(version: 1, key: key, senderAllowlist: providers); try config.validate()
        try ensurePrivateDirectory(directory)
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        guard try !pathExists(directory.appendingPathComponent("config.json")), try !pathExists(directory.appendingPathComponent("account.json")), try !pathExists(directory.appendingPathComponent("outbox.sqlite")), try !pathExists(directory.appendingPathComponent("activation.json")) else {
            throw CollectorError("A saved connection already exists. Nothing was overwritten; confirm that connection instead.")
        }
        let identity = try lookup(config.key).identity; try identity.validate()
        guard try confirm(identity) else { throw CollectorError("Connection cancelled. No key was saved and no Messages were read.") }
        try saveNewConfig(config, directory: directory)
        try saveNewAccountBinding(CollectorAccountBinding(version: 1, identity: identity, credentialHash: config.credentialHash, confirmedAt: stamp(clock())), directory: directory, config: config)
        try prepareCollectorHealthDevice(directory: directory, ownerId: identity.ownerId)
        accessCheck = nil
    }
    func confirmSavedAccount(confirm: (CollectorAccountIdentity) throws -> Bool) throws {
        try validateApp(); try ensurePrivateDirectory(directory)
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        let config = try loadConfig(directory)
        let existing = try pathExists(directory.appendingPathComponent("account.json")) ? loadAccountBinding(directory: directory, config: config) : nil
        let identity = try lookup(config.key).identity; try identity.validate()
        if let existing, existing.identity.ownerId != identity.ownerId { throw CollectorError("This key now belongs to a different account. Nothing was overwritten.") }
        guard try confirm(identity) else { throw CollectorError("Account confirmation cancelled. Existing setup was kept.") }
        if existing == nil { try saveNewAccountBinding(CollectorAccountBinding(version: 1, identity: identity, credentialHash: config.credentialHash, confirmedAt: stamp(clock())), directory: directory, config: config) }
        try prepareCollectorHealthDevice(directory: directory, ownerId: identity.ownerId)
        accessCheck = nil
    }
    private func freshConnection() throws -> (CollectorConfig, CollectorAccountBinding, CollectorAccountIdentity) {
        let config = try loadConfig(directory)
        let binding = try loadAccountBinding(directory: directory, config: config)
        let checked = try lookup(config.key), identity = checked.identity; try identity.validate()
        guard identity.ownerId == binding.identity.ownerId else { throw CollectorError("Alfred returned a different account. Collection stays off; review the connection.") }
        guard checked.setupReady else { throw CollectorError("Alfred's server setup needs finishing before this Mac can sync. No Messages were read or sent.") }
        return (config, binding, identity)
    }
    @discardableResult func checkMessagesAccess() throws -> CollectorAccountIdentity {
        try validateApp(); try ensurePrivateDirectory(directory)
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        accessCheck = nil
        let (config, _, identity) = try freshConnection()
        guard try readMessageHeaders() >= 0 else { throw CollectorError("Messages access could not be checked. No alert text was read or sent.") }
        accessCheck = CollectorAccessCheck(identity: identity, credentialHash: config.credentialHash, senderScope: scopeJSON(config), checkedAt: clock())
        return identity
    }
    @discardableResult func start(confirmedIdentity: CollectorAccountIdentity, consent: Bool) throws -> CollectorServiceStatus {
        guard consent else { throw CollectorError("Start cancelled. Collection stays off.") }
        try validateApp(); try ensurePrivateDirectory(directory)
        guard service.status != .unavailable else { throw CollectorError("The bundled background item is unavailable. Use a reviewed build before Start.") }
        let control = try CollectorSetupControlLock(directory: directory); defer { withExtendedLifetime(control) {} }
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        guard let checked = accessCheck, checked.identity == confirmedIdentity,
              clock().timeIntervalSince(checked.checkedAt) >= 0, clock().timeIntervalSince(checked.checkedAt) <= 300 else {
            throw CollectorError("Check Messages access again before choosing Start.")
        }
        let (config, binding, identity) = try freshConnection()
        guard identity == confirmedIdentity, checked.credentialHash == config.credentialHash, checked.senderScope == scopeJSON(config) else {
            accessCheck = nil; throw CollectorError("The account or provider choice changed. Review it and check access again before Start.")
        }
        let savedActivation = try loadCollectorActivation(directory: directory, config: config, binding: binding)
        if try !pathExists(directory.appendingPathComponent("outbox.sqlite")), savedActivation != nil { throw CollectorError("The original collection window is missing. Nothing was reset.") }
        let store = try OutboxStore(directory: directory)
        let unstarted = try emptyUnstartedCollectorStore(store)
        if unstarted && savedActivation != nil { throw CollectorError("The original collection window is missing. Nothing was reset.") }
        if !unstarted { _ = try store.baseline(config: config) }
        let highWater = try readMessageHeaders()
        guard highWater >= 0 else { accessCheck = nil; throw CollectorError("Messages access could not be checked. Collection stays off.") }
        if unstarted { try store.initialize(config: config, maxRowID: highWater, at: clock()) }
        let baseline = try store.baseline(config: config)
        if let saved = try loadCollectorActivation(directory: directory, config: config, binding: binding), saved.baselineAt != baseline.initializedAt {
            throw CollectorError("The saved start choice belongs to another collection window. Nothing was reset.")
        }
        let paused = CollectorActivation(version: 1, ownerId: identity.ownerId, credentialHash: config.credentialHash,
            senderScope: scopeJSON(config), baselineAt: baseline.initializedAt, enabled: false, decidedAt: stamp(clock()))
        try saveCollectorActivation(paused, directory: directory, config: config, binding: binding)
        do {
            if service.status == .notRegistered { try service.register() }
        } catch {
            // A system-approval result is not active collection. Its helper is
            // gated by the paused file until the user returns and chooses Start.
            if service.status != .requiresApproval { throw CollectorError("Automatic checks could not be enabled. Collection stays paused; review Login Items and setup.") }
        }
        guard service.status == .enabled else { return service.status }
        try saveCollectorActivation(CollectorActivation(version: 1, ownerId: identity.ownerId,
            credentialHash: config.credentialHash, senderScope: scopeJSON(config), baselineAt: baseline.initializedAt,
            enabled: true, decidedAt: stamp(clock())), directory: directory, config: config, binding: binding)
        return .enabled
    }
    func pause() throws {
        try validateApp()
        let control: CollectorSetupControlLock?
        if try pathExists(directory) { try ensurePrivateDirectory(directory); control = try CollectorSetupControlLock(directory: directory) }
        else { control = nil }
        defer { withExtendedLifetime(control) {} }
        var stateFailure = false
        if try pathExists(directory) {
            do {
                let config = try loadConfig(directory), binding = try loadAccountBinding(directory: directory, config: config)
                if let saved = try loadCollectorActivation(directory: directory, config: config, binding: binding) {
                    try saveCollectorActivation(CollectorActivation(version: 1, ownerId: saved.ownerId, credentialHash: saved.credentialHash,
                        senderScope: saved.senderScope, baselineAt: saved.baselineAt, enabled: false, decidedAt: stamp(clock())), directory: directory, config: config, binding: binding)
                }
            } catch { stateFailure = true }
        }
        // Pause never requires network or Messages access. Always attempt to
        // stop our own registered service even if saved setup needs repair.
        // It need not wait for an in-flight capture lock; an already accepted
        // server request may still complete after this local pause choice.
        do { if service.status == .enabled || service.status == .requiresApproval { try service.unregister() } }
        catch { throw CollectorError("Automatic checks need a pause review in Login Items. Saved alerts and the collection window were kept.") }
        if stateFailure { throw CollectorError("Background registration was stopped, but saved setup needs review before restarting. Saved alerts were kept.") }
    }
}
