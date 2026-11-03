import Foundation
import AppKit
import ServiceManagement

final class SystemCollectorBackgroundService: CollectorBackgroundService {
    private let service = SMAppService.agent(plistName: collectorAgentPlistName)
    var status: CollectorServiceStatus {
        let lookup: CollectorServiceLookup
        switch service.status {
        case .notRegistered: lookup = .notRegistered
        case .enabled: lookup = .enabled
        case .requiresApproval: lookup = .requiresApproval
        case .notFound: lookup = .notFound
        @unknown default: lookup = .unknown
        }
        return collectorServiceStatus(lookup: lookup, bundledAgentValid: (try? requireCollectorBundledAgent(at: Bundle.main.bundleURL)) != nil)
    }
    func register() throws {
        try requireDeclaredSandbox()
        try requireCollectorBundledAgent(at: Bundle.main.bundleURL)
        try service.register()
    }
    func unregister() throws { try service.unregister() }
}

// UI updates stay on main; coordinator work is confined to one serial queue.
final class CollectorSetupWindow: NSObject, NSWindowDelegate, @unchecked Sendable {
    private let coordinator: CollectorSetupCoordinator
    private let directory: URL
    private let queue = DispatchQueue(label: "com.hansopoku.alfred.collector.setup")
    private let window: NSWindow
    private let account = NSTextField(wrappingLabelWithString: "Connect your Alfred account.")
    private let key = NSSecureTextField()
    private let connect = NSButton(title: "Connect account", target: nil, action: nil)
    private let allProviders = NSButton(title: "Select supported providers", target: nil, action: nil)
    private var providers: [(id: String, button: NSButton)] = []
    private let access = NSTextField(wrappingLabelWithString: "Messages access has not been checked in this app.")
    private let checkAccess = NSButton(title: "Check Messages access", target: nil, action: nil)
    private let privacy = NSButton(title: "Open Mac privacy settings", target: nil, action: nil)
    private let start = NSButton(title: "Start", target: nil, action: nil)
    private let pause = NSButton(title: "Pause", target: nil, action: nil)
    private let loginItems = NSButton(title: "Background settings", target: nil, action: nil)
    private let refresh = NSButton(title: "Refresh status", target: nil, action: nil)
    private let review = NSButton(title: "Review saved alerts", target: nil, action: nil)
    private let done = NSButton(title: "Done", target: nil, action: nil)
    private let syncState = NSTextField(wrappingLabelWithString: "Sync is off.")
    private let feedback = NSTextField(wrappingLabelWithString: "")
    private var snapshot: CollectorSetupSnapshot?
    private var busy = false

    init(directory: URL, coordinator: CollectorSetupCoordinator) {
        self.directory = directory; self.coordinator = coordinator
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 700, height: 790),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Alfred Sync"; window.minSize = NSSize(width: 620, height: 680)
        window.isReleasedWhenClosed = false; window.delegate = self
        let heading = NSTextField(labelWithString: "Alfred Sync")
        heading.font = .systemFont(ofSize: 24, weight: .semibold)
        let introduction = NSTextField(wrappingLabelWithString: "Bring new payment alerts into Alfred automatically while this Mac is awake. Choose money-in and money-out announcements separately in Alfred’s Automations settings.")
        introduction.textColor = .secondaryLabelColor
        key.placeholderString = "Existing forwarding key from Alfred → Bank messages"
        key.isEditable = true; key.isSelectable = true
        key.setAccessibilityLabel("Alfred forwarding key")
        connect.target = self; connect.action = #selector(connectAccount)
        let keyRow = row([key, connect]); key.widthAnchor.constraint(greaterThanOrEqualToConstant: 280).isActive = true
        account.font = .systemFont(ofSize: 13)
        let providerNames = [("absa", "Absa"), ("mobilemoney", "MobileMoney"), ("hubtel", "Hubtel"), ("paysmall", "PaySmall"),
            ("t-cash", "T-Cash"), ("vf-cash", "VF-Cash"), ("t cash", "T Cash"), ("stanchart", "StanChart")]
        let providerGrid = NSGridView(views: stride(from: 0, to: providerNames.count, by: 2).map { offset -> [NSView] in
            (offset..<offset + 2).map { index -> NSView in
                let entry = providerNames[index]
                let button = NSButton(checkboxWithTitle: entry.1, target: nil, action: nil)
                providers.append((entry.0, button)); return button
            }
        })
        providerGrid.columnSpacing = 40; providerGrid.rowSpacing = 5
        allProviders.target = self; allProviders.action = #selector(selectProviders)
        privacy.target = self; privacy.action = #selector(openPrivacy)
        checkAccess.target = self; checkAccess.action = #selector(checkMessages)
        let permission = NSTextField(wrappingLabelWithString: "If macOS asks, allow Alfred Sync in Privacy & Security → Full Disk Access. That permission is broad; Alfred filters forwarding to the providers you select. Your iPhone SMS must already arrive in Messages on this Mac. This check doesn’t read payment-message text.")
        permission.textColor = .secondaryLabelColor
        start.target = self; start.action = #selector(startSync)
        pause.target = self; pause.action = #selector(pauseSync)
        loginItems.target = self; loginItems.action = #selector(openBackgroundSettings)
        refresh.target = self; refresh.action = #selector(refreshStatus)
        review.target = self; review.action = #selector(reviewAlerts)
        done.target = self; done.action = #selector(closeWindow)
        let privacyNote = NSTextField(wrappingLabelWithString: "Opening this app starts no collection. Start is an explicit choice to forward selected provider alerts to your confirmed Alfred account. Existing saved alerts and the original collection window are kept when paused or resumed.")
        privacyNote.textColor = .secondaryLabelColor
        let stack = NSStackView(views: [heading, introduction, section("1  Connect your account and choose providers"),
            keyRow, account, providerGrid, allProviders, section("2  Allow and check Messages access"), permission,
            row([privacy, checkAccess]), access, section("3  Start automatic checks"), syncState,
            row([start, pause, loginItems, refresh]), feedback, privacyNote, row([review, done])])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 11
        stack.translatesAutoresizingMaskIntoConstraints = false
        // Three readable setup steps must remain reachable on smaller screens.
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true; scroll.drawsBackground = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        let document = NSView(); document.translatesAutoresizingMaskIntoConstraints = false
        document.addSubview(stack); scroll.documentView = document
        window.contentView!.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
            document.leadingAnchor.constraint(equalTo: scroll.contentView.leadingAnchor),
            document.topAnchor.constraint(equalTo: scroll.contentView.topAnchor),
            document.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor),
            stack.leadingAnchor.constraint(equalTo: document.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: document.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: document.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: document.bottomAnchor, constant: -22)
        ])
        for view in [introduction, account, permission, access, syncState, feedback, privacyNote] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        keyRow.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        feedback.textColor = .secondaryLabelColor
    }
    private func row(_ views: [NSView]) -> NSStackView {
        let value = NSStackView(views: views); value.orientation = .horizontal; value.spacing = 9
        return value
    }
    private func section(_ title: String) -> NSTextField {
        let value = NSTextField(labelWithString: title); value.font = .systemFont(ofSize: 14, weight: .semibold); return value
    }
    private func apply(_ value: CollectorSetupSnapshot) {
        snapshot = value
        if let identity = value.identity { account.stringValue = "Connected to \(identity.preferredName) (\(identity.email)). This is the saved account; Start checks it again online." }
        else if value.needsSavedAccountConfirmation { account.stringValue = "A connection was saved but still needs your account confirmation. Its key and alerts have been kept." }
        else { account.stringValue = "Use an existing forwarding key from your signed-in Alfred account. Confirm the name and email before it is saved." }
        if !value.providers.isEmpty { for provider in providers { provider.button.state = value.providers.contains(provider.id) ? .on : .off } }
        connect.title = value.providers.isEmpty ? "Connect account" : "Confirm saved account"
        access.stringValue = value.accessCheckedAt.map { "Messages access checked \(DateFormatter.localizedString(from: $0, dateStyle: .none, timeStyle: .short)). Start checks access again. No alert text was read by this check." } ?? "Messages access has not been checked in this app."
        switch value.service {
        case .enabled:
            syncState.stringValue = value.explicitlyEnabled ? "Automatic checks are on: once a minute while logged in and awake. This is schedule status, not proof that an alert was accepted." : "Background registration exists, but collection is paused. Review setup and choose Start."
        case .requiresApproval: syncState.stringValue = "macOS needs background approval. Open Background settings, review Alfred Sync, then return here and choose Start. Collection stays off until then."
        case .notRegistered: syncState.stringValue = "Automatic checks are off. Choose Start after checking access."
        case .registrationUnknown: syncState.stringValue = "Automatic checks are not yet confirmed. After checking access, choose Start to ask macOS to enable them."
        case .unavailable: syncState.stringValue = "This copy of Alfred Sync cannot start automatic checks. Use a complete, reviewed copy of the app."
        }
        if let status = value.outbox {
            syncState.stringValue += " \(status.pendingCount) saved alert(s) await acceptance; \(status.heldForReviewCount) need review."
        }
        updateEnabled()
    }
    private func updateEnabled() {
        let configured = !(snapshot?.providers.isEmpty ?? true)
        key.isEnabled = !busy && !configured
        connect.isEnabled = !busy
        allProviders.isEnabled = !busy && !configured
        for item in providers { item.button.isEnabled = !busy && !configured }
        privacy.isEnabled = !busy; checkAccess.isEnabled = !busy && snapshot?.identity != nil
        start.isEnabled = !busy && snapshot?.identity != nil && snapshot?.accessCheckedAt != nil && snapshot?.service != .unavailable && !(snapshot?.explicitlyEnabled == true && snapshot?.service == .enabled)
        pause.isEnabled = !busy && (snapshot?.explicitlyEnabled == true || snapshot?.service == .enabled || snapshot?.service == .requiresApproval || snapshot?.service == .registrationUnknown)
        loginItems.isEnabled = !busy; refresh.isEnabled = !busy; done.isEnabled = !busy
        review.isEnabled = !busy && snapshot?.outbox != nil
    }
    private func perform(_ progress: String, success: String, action: @escaping () throws -> Void) {
        guard !busy else { return }; busy = true; feedback.textColor = .secondaryLabelColor
        feedback.stringValue = progress; updateEnabled()
        queue.async {
            do {
                try action(); let state = try self.coordinator.snapshot()
                DispatchQueue.main.async { self.busy = false; self.apply(state); self.feedback.textColor = .secondaryLabelColor; self.feedback.stringValue = success }
            } catch {
                let state = try? self.coordinator.snapshot()
                let message = (error as? CollectorError)?.description ?? "Setup could not complete. Nothing was reset; review the connection and permissions."
                DispatchQueue.main.async {
                    self.busy = false; if let state { self.apply(state) }; self.updateEnabled()
                    self.feedback.textColor = .systemRed; self.feedback.stringValue = message
                }
            }
        }
    }
    private func confirm(_ identity: CollectorAccountIdentity) -> Bool {
        var accepted = false
        DispatchQueue.main.sync {
            guard self.window.isVisible else { return }
            let prompt = NSAlert(); prompt.messageText = "Connect this Mac to \(identity.preferredName)?"
            prompt.informativeText = "Account: \(identity.email). Selected provider alerts will go to this Alfred account only after you later choose Start. If this is not your account, cancel."
            prompt.addButton(withTitle: "Cancel"); prompt.addButton(withTitle: "Connect this account")
            accepted = prompt.runModal() == .alertSecondButtonReturn
        }
        return accepted
    }
    @objc private func connectAccount() {
        if snapshot?.providers.isEmpty == false {
            perform("Checking your saved account…", success: "Account confirmed. Check Messages access next.") {
                try self.coordinator.confirmSavedAccount(confirm: self.confirm)
            }; return
        }
        let secret: String
        do { secret = try collectorConnectionKey(key.stringValue) }
        catch { feedback.stringValue = String(describing: error); return }
        key.stringValue = ""
        let selected = providers.filter { $0.button.state == .on }.map(\.id)
        perform("Checking your Alfred account…", success: "Account connected. No Messages were read and collection is still off.") {
            try self.coordinator.connect(key: secret, providers: selected, confirm: self.confirm)
        }
    }
    @objc private func selectProviders() { for item in providers where item.button.isEnabled { item.button.state = .on } }
    @objc private func openPrivacy() { NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!) }
    @objc private func openBackgroundSettings() { SMAppService.openSystemSettingsLoginItems() }
    @objc private func checkMessages() {
        perform("Checking the account, server setup and Messages access…", success: "Access checked. No alert text was read or sent. Review Start when you are ready.") {
            _ = try self.coordinator.checkMessagesAccess()
        }
    }
    @objc private func startSync() {
        guard !busy, let state = snapshot, let identity = state.identity else { return }
        let prompt = NSAlert(); prompt.messageText = "Start syncing new payment alerts?"
        prompt.informativeText = "Send selected provider alert text, sender and received time to \(identity.preferredName) (\(identity.email)) in Alfred. Providers: \(state.providers.joined(separator: ", ")). Personal senders and credential codes are excluded. Unfamiliar alerts may use Alfred’s configured parser. \(state.baselineAt == nil ? "Only alerts arriving from this start onward qualify; older Messages stay out." : "Resume the original collection window; eligible alerts since the first Start can be retried, and older history stays out.") The app will check once a minute while awake. Chat announcements and device nudges are separate choices in Alfred."
        prompt.addButton(withTitle: "Cancel"); prompt.addButton(withTitle: "Start automatic checks")
        guard prompt.runModal() == .alertSecondButtonReturn else { return }
        perform("Checking setup and starting automatic checks…", success: "Start choice saved. See the schedule status above; macOS may still need background approval.") {
            _ = try self.coordinator.start(confirmedIdentity: identity, consent: true)
        }
    }
    @objc private func pauseSync() {
        perform("Pausing automatic checks…", success: "Automatic checks paused. Your account, saved alerts and original collection window were kept.") { try self.coordinator.pause() }
    }
    @objc private func refreshStatus() { perform("Checking saved setup…", success: "Saved setup refreshed. No Messages were read or sent.") {} }
    @objc private func reviewAlerts() {
        do { try runHeldAlertReview(directory: directory) }
        catch { feedback.textColor = .systemRed; feedback.stringValue = (error as? CollectorError)?.description ?? "Saved alerts could not be opened." }
    }
    @objc private func closeWindow() { window.close() }
    func windowWillClose(_ notification: Notification) { NSApplication.shared.stopModal() }
    func run() { window.center(); window.makeKeyAndOrderFront(nil); refreshStatus(); NSApplication.shared.runModal(for: window) }
}

func runCollectorSetupWindow(directory: URL) {
    let app = NSApplication.shared; app.setActivationPolicy(.accessory)
    let coordinator = CollectorSetupCoordinator(directory: directory, service: SystemCollectorBackgroundService(),
        validateApp: requireDeclaredSandbox, lookup: fetchCollectorAccountCheck,
        readMessageHeaders: { try MessageSource(path: actualMessagesPath()).checkHeaderAccess() })
    let setup = CollectorSetupWindow(directory: directory, coordinator: coordinator); setup.run()
}
