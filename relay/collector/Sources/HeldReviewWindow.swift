import Foundation
import AppKit

// This explicit window reviews the collector's existing private outbox only.
// It never opens Messages, verifies a key over HTTP, runs ingestion or starts a
// background service. Account freshness is labelled honestly below.
final class HeldAlertReviewWindow: NSObject, NSWindowDelegate {
    private let session: HeldAlertReviewSession
    private let window: NSWindow
    private let summary = NSTextField(wrappingLabelWithString: "")
    private let sender = NSTextField(labelWithString: "")
    private let content = NSTextView()
    private let status = NSTextField(wrappingLabelWithString: "")
    private let retry = NSButton(title: "Try again", target: nil, action: nil)
    private let ignore = NSButton(title: "Not a payment", target: nil, action: nil)
    private let later = NSButton(title: "Later", target: nil, action: nil)
    private var current: HeldAlertSnapshot?
    private var afterRowID: Int64 = 0

    init(directory: URL) throws {
        session = try HeldAlertReviewSession(directory: directory)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 650, height: 540),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Alerts to review · Alfred"
        window.minSize = NSSize(width: 560, height: 480)
        window.delegate = self; window.isReleasedWhenClosed = false
        let heading = NSTextField(labelWithString: "Alerts to review")
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        let account = NSTextField(wrappingLabelWithString: "Saved connection: \(session.identity.preferredName) (\(session.identity.email)). This window uses your saved account confirmation; it has not checked the connection online.")
        account.textColor = .secondaryLabelColor
        summary.font = .systemFont(ofSize: 13)
        sender.font = .systemFont(ofSize: 14, weight: .semibold)
        let scroll = NSScrollView(); scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder
        content.isEditable = false; content.isSelectable = true; content.isRichText = false
        content.font = .systemFont(ofSize: 14); content.textContainerInset = NSSize(width: 12, height: 12)
        content.autoresizingMask = [.width]; content.isVerticallyResizable = true
        content.isHorizontallyResizable = false; content.textContainer?.widthTracksTextView = true
        scroll.documentView = content
        let warning = NSTextField(wrappingLabelWithString: "Some of this alert may already be in Alfred. These choices only manage the copy saved on this Mac; they do not add, remove or undo financial records.")
        warning.textColor = .secondaryLabelColor
        retry.target = self; retry.action = #selector(tryAgain)
        ignore.target = self; ignore.action = #selector(notPayment)
        later.target = self; later.action = #selector(saveForLater)
        let refresh = NSButton(title: "Refresh", target: self, action: #selector(refreshList))
        let done = NSButton(title: "Done", target: self, action: #selector(closeWindow))
        let buttons = NSStackView(views: [retry, ignore, later, refresh, done])
        buttons.orientation = .horizontal; buttons.spacing = 10
        let stack = NSStackView(views: [heading, account, summary, sender, scroll, warning, status, buttons])
        stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor, constant: -24),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 130),
            warning.widthAnchor.constraint(equalTo: stack.widthAnchor),
            account.widthAnchor.constraint(equalTo: stack.widthAnchor),
            summary.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        status.textColor = .secondaryLabelColor
    }

    private func displayText(_ text: String) -> String {
        // Hide direction/format controls so provider text cannot visually
        // disguise the fixed account, warning, or action labels.
        String(String.UnicodeScalarView(text.unicodeScalars.filter {
            $0.properties.generalCategory != .format &&
            (!CharacterSet.controlCharacters.contains($0) || $0 == "\n" || $0 == "\t")
        }))
    }
    func show() {
        loadList()
        window.center(); window.makeKeyAndOrderFront(nil)
    }
    private func loadList(message: String = "") {
        do {
            let list = try session.list(afterRowID: afterRowID)
            let unreadable = list.unreadableCount
            let sourceIssues = list.otherSourceIssueCount
            summary.stringValue = "\(list.heldCount) saved alert\(list.heldCount == 1 ? "" : "s") to review." +
                (unreadable > 0 ? " \(unreadable) could not be read." : "") +
                (sourceIssues > 0 ? " \(sourceIssues) need more information from Messages." : "") +
                (unreadable + sourceIssues > 0 ? " These stay saved for the collector to check again; their text is not available here." : "")
            current = list.alerts.first
            if let current {
                let date = parseStamp(current.message.receivedAt).map {
                    DateFormatter.localizedString(from: $0, dateStyle: .medium, timeStyle: .short)
                } ?? "Saved alert"
                sender.stringValue = "Provider message · \(displayText(current.message.sender)) · \(date)"
                content.string = displayText(current.message.body)
            } else {
                sender.stringValue = list.heldCount > 0 ? "Saved for later" : "No readable alerts waiting for review"
                content.string = ""
            }
            [retry, ignore, later].forEach { $0.isEnabled = current != nil }
            status.stringValue = message
        } catch { showFailure(error) }
    }
    private func showFailure(_ error: Error) {
        current = nil; content.string = ""; sender.stringValue = "Review paused"
        [retry, ignore, later].forEach { $0.isEnabled = false }
        status.stringValue = (error as? CollectorError)?.description ?? "The saved alerts could not be checked. Nothing was changed."
    }
    private func decide(_ action: HeldAlertAction, confirmed: Bool = false) {
        guard let snapshot = current else { return }
        do {
            _ = try session.decide(snapshot, action: action, confirmedNotPayment: confirmed)
            // Advance by a stable local row cursor, rather than repeatedly
            // fetching the first 100 deferred alerts. All later pages remain
            // reachable in this visit; Refresh includes saved-for-later items.
            afterRowID = snapshot.localRowID
            let text: String
            switch action {
            case .tryAgain: text = "Saved for the collector to try again. Nothing was sent now. The same alert will be used to prevent duplicates."
            case .notPayment: text = "The saved copy was removed. Existing financial records in Alfred are unchanged."
            case .later: text = "Kept safely on this Mac for later."
            }
            loadList(message: text)
        } catch { showFailure(error) }
    }
    @objc private func tryAgain() { decide(.tryAgain) }
    @objc private func notPayment() {
        guard current != nil else { return }
        let confirmation = NSAlert()
        confirmation.messageText = "Is this not a payment alert?"
        confirmation.informativeText = "This removes only the saved copy on this Mac and stops the collector trying it again. Some of the alert may already be recorded in Alfred. Those records stay unchanged. If you are unsure, choose Keep alert."
        confirmation.addButton(withTitle: "Keep alert")
        confirmation.addButton(withTitle: "Not a payment")
        guard confirmation.runModal() == .alertSecondButtonReturn else { return }
        decide(.notPayment, confirmed: true)
    }
    @objc private func saveForLater() { decide(.later) }
    @objc private func refreshList() { afterRowID = 0; loadList() }
    @objc private func closeWindow() { window.close() }
    func windowWillClose(_ notification: Notification) { NSApplication.shared.stopModal() }
    func run() { show(); NSApplication.shared.runModal(for: window) }
}

func runHeldAlertReview(directory: URL) throws {
    let hasConfig = try pathExists(directory.appendingPathComponent("config.json"))
    let hasAccount = try pathExists(directory.appendingPathComponent("account.json"))
    let hasOutbox = try pathExists(directory.appendingPathComponent("outbox.sqlite"))
    guard hasConfig && hasAccount && hasOutbox else {
        throw CollectorError("There are no saved alerts to review yet. This Mac needs its own account connection and collection setup first. Nothing was read from Messages or sent.")
    }
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    let review = try HeldAlertReviewWindow(directory: directory)
    review.run()
}
