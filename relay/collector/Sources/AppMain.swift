import Foundation
import AppKit
import Security
import CoreFoundation
import Darwin

let expectedBundleID = "com.hansopoku.alfred.collector"
let expectedReadPaths = ["/Library/Messages/chat.db", "/Library/Messages/chat.db-wal", "/Library/Messages/chat.db-shm"]
func booleanEntitlement(_ value: Any?) -> Bool {
    guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
    return number.boolValue
}
// Public code-signing inspection, not a runtime sandbox initializer. The OS
// applies the declared App Sandbox when this staged app is eventually launched.
func requireDeclaredSandbox() throws {
    var code: SecCode?; var staticCode: SecStaticCode?; var information: CFDictionary?
    guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code,
          SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess, let staticCode,
          SecStaticCodeCheckValidity(staticCode, SecCSFlags(rawValue: kSecCSStrictValidate), nil) == errSecSuccess,
          SecCodeCopySigningInformation(staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &information) == errSecSuccess,
          let details = information as? [String: Any],
          let entitlements = details[kSecCodeInfoEntitlementsDict as String] as? [String: Any],
          Set(entitlements.keys) == Set(["com.apple.security.app-sandbox", "com.apple.security.network.client", "com.apple.security.temporary-exception.files.home-relative-path.read-only"]),
          booleanEntitlement(entitlements["com.apple.security.app-sandbox"]),
          booleanEntitlement(entitlements["com.apple.security.network.client"]),
          entitlements["com.apple.security.network.server"] as? Bool != true,
          entitlements["com.apple.security.files.user-selected.read-write"] == nil,
          entitlements["com.apple.security.temporary-exception.files.home-relative-path.read-write"] == nil,
          let paths = entitlements["com.apple.security.temporary-exception.files.home-relative-path.read-only"] as? [String],
          Set(paths) == Set(expectedReadPaths), Bundle.main.bundleIdentifier == expectedBundleID else {
        throw CollectorError("Required declared App Sandbox identity/scope is absent or changed. Refusing live configuration, file access or delivery.")
    }
}
func containerSupport() throws -> URL {
    guard let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { throw CollectorError("Application container support path unavailable.") }
    return support.appendingPathComponent("AlfredCollector", isDirectory: true)
}
func actualMessagesPath() throws -> String {
    // NSHomeDirectory is remapped to a container in App Sandbox. POSIX user
    // account metadata locates the real home; it grants no file access itself.
    guard let user = getpwuid(getuid()), let home = user.pointee.pw_dir else { throw CollectorError("Cannot determine the user's home directory.") }
    return URL(fileURLWithPath: String(cString: home)).appendingPathComponent("Library/Messages/chat.db").path
}
func jsonOutput<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(value)); FileHandle.standardOutput.write(Data("\n".utf8))
}
func promptForExistingKey() throws -> String {
    guard isatty(STDIN_FILENO) == 1, isatty(STDERR_FILENO) == 1 else { throw CollectorError("Key entry requires a private interactive terminal; no key argument/environment supported.") }
    var original = termios()
    guard tcgetattr(STDIN_FILENO, &original) == 0 else { throw CollectorError("Cannot protect terminal input.") }
    var hidden = original; hidden.c_lflag &= ~tcflag_t(ECHO)
    guard tcsetattr(STDIN_FILENO, TCSAFLUSH, &hidden) == 0 else { throw CollectorError("Cannot hide terminal input.") }
    defer { var restore = original; tcsetattr(STDIN_FILENO, TCSAFLUSH, &restore); FileHandle.standardError.write(Data("\n".utf8)) }
    FileHandle.standardError.write(Data("Existing forwarding key for the approved Alfred account (hidden): ".utf8))
    guard let key = readLine(strippingNewline: true) else { throw CollectorError("Key entry cancelled.") }; return key
}
func promptToConfirmAccount(_ identity: CollectorAccountIdentity) throws -> Bool {
    guard isatty(STDIN_FILENO) == 1, isatty(STDERR_FILENO) == 1 else { throw CollectorError("Account confirmation requires a private interactive terminal. Nothing was connected.") }
    FileHandle.standardError.write(Data("Connect this Mac to \(identity.preferredName) (\(identity.email))?\nType CONNECT to confirm, or press Return to cancel: ".utf8))
    return readLine(strippingNewline: true) == "CONNECT"
}
struct SafeCollectorStatus: Encodable {
    let accountConfirmedLocally: Bool
    let accountFreshlyChecked: Bool = false
    let accountConfirmedAt: String?
    let outbox: OutboxStatus?
}
func command(_ requestedArgs: [String]) throws {
    try requireDeclaredSandbox()
    let directory = try containerSupport()
    let scheduled = requestedArgs == ["--scheduled-run"]
    let args = scheduled ? ["--run"] : requestedArgs
    if args == ["--review-held"] {
        // Explicit local outbox review only: no Messages access, remote account
        // lookup, delivery, health check-in, setup, or service registration.
        try runHeldAlertReview(directory: directory); return
    }
    if args.first == "--configure" {
        var senders: [String] = []; var index = 1
        while index < args.count {
            guard args[index] == "--sender", index + 1 < args.count else { throw CollectorError("Use --configure --sender ID [--sender ID ...].") }
            senders.append(args[index + 1]); index += 2
        }
        guard !senders.isEmpty else { throw CollectorError("Explicit sender IDs required; no key was requested.") }
        // Validate scope with a synthetic format placeholder before prompting.
        try CollectorConfig(version: 1, key: "alf_" + String(repeating: "x", count: 24), senderAllowlist: senders).validate()
        if try pathExists(directory.appendingPathComponent("config.json")) || pathExists(directory.appendingPathComponent("account.json")) { throw CollectorError("An existing account/configuration cannot be overwritten; no key requested.") }
        let config = CollectorConfig(version: 1, key: try promptForExistingKey(), senderAllowlist: senders)
        try config.validate()
        let identity = try confirmedAccount(key: config.key, confirm: promptToConfirmAccount)
        try saveNewConfig(config, directory: directory)
        // A partial save remains inactive. --verify-account can complete the
        // missing confirmation file without resetting a baseline or queued text.
        try saveNewAccountBinding(CollectorAccountBinding(version: 1, identity: identity, credentialHash: config.credentialHash, confirmedAt: stamp()), directory: directory, config: config)
        try prepareCollectorHealthDevice(directory: directory, ownerId: identity.ownerId)
        print("Account connected and confirmed. No Messages read, baseline created, payment alert sent or autostart enabled."); return
    }
    guard args.count == 1, ["--status", "--verify-account", "--initialize", "--collect", "--deliver", "--run"].contains(args[0]) else { throw CollectorError("Supported explicit commands: --status, --verify-account, --initialize, --collect, --deliver, --run, --configure --sender ID.... No operation performed.") }
    let config = try loadConfig(directory)
    if args == ["--status"] {
        let binding = try? loadAccountBinding(directory: directory, config: config)
        let outbox = try pathExists(directory.appendingPathComponent("outbox.sqlite")) ? OutboxStore(directory: directory, readOnly: true).status(config: config) : nil
        try jsonOutput(SafeCollectorStatus(accountConfirmedLocally: binding != nil, accountConfirmedAt: binding?.confirmedAt, outbox: outbox)); return
    }
    if args == ["--verify-account"] {
        guard isatty(STDIN_FILENO) == 1, isatty(STDERR_FILENO) == 1 else { throw CollectorError("Account confirmation requires a private interactive terminal. Nothing was connected.") }
        let existing = try pathExists(directory.appendingPathComponent("account.json")) ? loadAccountBinding(directory: directory, config: config) : nil
        let identity = try confirmedAccount(key: config.key, confirm: { identity in
            if let existing, existing.identity.ownerId != identity.ownerId { throw CollectorError("Alfred returned a different account. Nothing was overwritten; review the account connection.") }
            return try promptToConfirmAccount(identity)
        })
        if existing == nil { try saveNewAccountBinding(CollectorAccountBinding(version: 1, identity: identity, credentialHash: config.credentialHash, confirmedAt: stamp()), directory: directory, config: config) }
        try prepareCollectorHealthDevice(directory: directory, ownerId: identity.ownerId)
        print("Account connection confirmed. Existing baseline and queued alerts are unchanged; no Messages were read or sent."); return
    }
    // Existing unverified configurations fail before any Messages read or send.
    // Even a previously confirmed key must still resolve to that exact owner.
    let binding: CollectorAccountBinding
    if scheduled {
        let saved = try loadAccountBinding(directory: directory, config: config)
        guard try scheduledCollectorRunAllowed(directory: directory, config: config, binding: saved) else { print("Automatic checks are paused."); return }
        let checked = try fetchCollectorAccountCheck(key: config.key)
        guard checked.setupReady, checked.identity.ownerId == saved.identity.ownerId else { throw CollectorError("Alfred's account or server setup is not ready. No Messages were read or sent.") }
        binding = saved
    } else { binding = try verifiedAccountBinding(config: config, directory: directory) }
    try ensurePrivateDirectory(directory)
    let operationLock = try CollectorLock(directory: directory); defer { withExtendedLifetime(operationLock) {} }
    if scheduled, try !scheduledCollectorRunAllowed(directory: directory, config: config, binding: binding) { print("Automatic checks are paused."); return }
    let store = try OutboxStore(directory: directory)
    let reportsHealth = args == ["--collect"] || args == ["--run"]
    var healthCaptureFailed = reportsHealth
    // The count-only check-in runs after capture and any outbox delivery, even
    // when those steps throw. Its failure never changes their outcome/state.
    defer {
        let stillAllowed = !scheduled || (try? scheduledCollectorRunAllowed(directory: directory, config: config, binding: binding)) == true
        if reportsHealth && stillAllowed && !reportCollectorHealthBestEffort(store: store, config: config, binding: binding, directory: directory, captureFailed: healthCaptureFailed) {
            FileHandle.standardError.write(Data("Mac status check-in unavailable. Captured alerts and delivery state are unchanged.\n".utf8))
        }
    }
    if args == ["--initialize"] {
        let time = Date(); let source = try MessageSource(path: actualMessagesPath())
        try store.initialize(config: config, maxRowID: source.highWaterMark(), at: time)
        print("Future-only baseline initialized. No SMS bodies read or sent; no service enabled."); return
    }
    // Validate existing baseline before any access to Messages or a recipient.
    let baseline = try store.baseline(config: config)
    var cycleFailed = false
    if args == ["--collect"] || args == ["--run"] {
        do {
            if scheduled, try !scheduledCollectorRunAllowed(directory: directory, config: config, binding: binding) { return }
            let source = try MessageSource(path: actualMessagesPath())
            let batch = try source.captureBatch(baseline: baseline, config: config, retry: store.sourceQuarantine(config: config))
            if scheduled, try !scheduledCollectorRunAllowed(directory: directory, config: config, binding: binding) { return }
            let count = try store.capture(batch, config: config)
            healthCaptureFailed = false
            let health = try store.status(config: config)
            print("Captured \(count) provider alert(s); scannedHeaders=\(batch.scannedRowCount); morePending=\(batch.hasMore); sourceRowsAwaitingRepair=\(health.sourceQuarantineCount). No content printed.")
        } catch {
            healthCaptureFailed = true
            if args != ["--run"] { throw error }
            cycleFailed = true
            let reason = (error as? CollectorError)?.description ?? "Local capture failure."
            FileHandle.standardError.write(Data("Capture held: \(reason) Previously queued delivery will be attempted independently.\n".utf8))
        }
    }
    if args == ["--deliver"] || args == ["--run"] {
        let count = try deliverPending(store: store, config: config,
            maySend: { if !scheduled { return true }; return try scheduledCollectorRunAllowed(directory: directory, config: config, binding: binding) },
            transport: { message, key in deliverHTTP(message, key: key, expectedOwnerId: binding.identity.ownerId) })
        let status = try store.status(config: config)
        print("Alfred durably acknowledged \(count) alert(s); only those raw payloads were removed. Held for review: \(status.heldForReviewCount); pending total: \(status.pendingCount). This is not proof of new financial records.")
    }
    if cycleFailed { throw CollectorError("Automatic cycle incomplete: capture remains held. No reset/backfill was performed.") }
}
@main struct CollectorApp {
    static func main() {
        umask(0o077)
        let args = Array(CommandLine.arguments.dropFirst())
        if args.isEmpty {
            do { try requireDeclaredSandbox(); runCollectorSetupWindow(directory: try containerSupport()) }
            catch {
                let app = NSApplication.shared; app.setActivationPolicy(.accessory)
                let notice = NSAlert(); notice.messageText = "Alfred Sync needs a setup review"
                notice.informativeText = "This app's required identity or file scope could not be verified. Collection stays off. Use a reviewed build; changing Mac privacy settings does not fix an altered app."
                notice.addButton(withTitle: "Done"); notice.runModal()
            }
            return
        }
        do { try command(args) }
        catch { let message = (error as? CollectorError)?.description ?? "Local operation failed. No raw message, credential or automatic reset is logged."; FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
    }
}
