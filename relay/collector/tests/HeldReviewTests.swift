import Foundation
import SQLite3
import Darwin

private var checks = 0
private struct ReviewFixtureFailure: Error { let label: String }
private func check(_ condition: @autoclosure () throws -> Bool, _ label: String) throws {
    checks += 1; if try !condition() { throw ReviewFixtureFailure(label: label) }
}
private func rejects(_ label: String, _ block: () throws -> Void) throws {
    do { try block() } catch { checks += 1; return }
    throw ReviewFixtureFailure(label: label)
}
private let time = Date(timeIntervalSince1970: 1_794_000_000)
private let identity = CollectorAccountIdentity(ownerId: "11111111-1111-4111-8111-111111111111", preferredName: "Fictional User", email: "fictional@example.invalid")
private let otherIdentity = CollectorAccountIdentity(ownerId: "22222222-2222-4222-8222-222222222222", preferredName: "Other Fictional User", email: "other@example.invalid")
private func config(_ keyCharacter: String = "x", senders: [String] = ["mobilemoney"]) -> CollectorConfig {
    CollectorConfig(version: 1, key: "alf_" + String(repeating: keyCharacter, count: 24), senderAllowlist: senders)
}
private func binding(_ owner: CollectorAccountIdentity = identity, config: CollectorConfig = config()) -> CollectorAccountBinding {
    CollectorAccountBinding(version: 1, identity: owner, credentialHash: config.credentialHash, confirmedAt: stamp(time))
}
private func message(_ row: Int64) -> CapturedMessage {
    CapturedMessage(rowID: row, guid: "fictional-held-\(row)", sender: "mobilemoney", body: "Fictional payment GHS \(row * 10)", receivedAt: stamp(time.addingTimeInterval(Double(row))), service: "SMS")
}
private func fixture(_ work: (OutboxStore, URL) throws -> Void) throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("alfred-held-review-fixtures-" + UUID().uuidString).resolvingSymlinksInPath()
    try ensurePrivateDirectory(root); defer { try? FileManager.default.removeItem(at: root) }
    try saveNewConfig(config(), directory: root)
    try saveNewAccountBinding(binding(), directory: root, config: config())
    let store = try OutboxStore(directory: root)
    try store.initialize(config: config(), maxRowID: 0, at: time)
    _ = try store.capture(CaptureBatch(messages: [message(1), message(2)], lastRowID: 3, hasMore: false,
        quarantined: [SourceQuarantine(reference: SourceReference(rowID: 3, guidHash: digest("unreadable-fixture")), reason: .unreadableBody)]), config: config())
    try store.holdForReview(message(1).guid, config: config())
    try store.holdForReview(message(2).guid, config: config())
    try work(store, root)
}
private func replaceBinding(_ value: CollectorAccountBinding, directory: URL) throws {
    let url = directory.appendingPathComponent("account.json")
    try JSONEncoder().encode(value).write(to: url)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
}
private func testDecisions() throws {
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let list = try session.list()
        try check(list.alerts.count == 2 && list.heldCount == 2, "readable held alerts listed")
        try check(list.unreadableCount == 1 && list.otherSourceIssueCount == 0, "quarantined source is count-only")
        try check(list.identity == identity, "saved account displayed")
        try check(store.db.scalarInt("select count(*) from sqlite_master where name like 'held_review_%'") == 0, "opening review does not create ledger or mutate capture")
        let first = list.alerts[0]
        try check(first.message.guid == message(1).guid && first.fingerprint == message(1).fingerprint, "stable source identity and payload preserved")
        try check(session.decide(first, action: .later) == .applied, "later explicitly audited")
        try check(session.decide(first, action: .later) == .alreadyApplied, "repeated later is idempotent")
        try check(store.status(config: config()).heldForReviewCount == 2, "later preserves held payload")
        try check(session.decide(first, action: .tryAgain) == .applied, "retry releases exact held event")
        try check(session.decide(first, action: .tryAgain) == .alreadyApplied, "repeated retry is idempotent")
        let pending = try store.pending(config: config())
        try check(pending.count == 1 && pending[0].guid == first.message.guid && pending[0].body == first.message.body, "retry uses original event and body")
        try check(pending[0].attempts == first.message.attempts, "retry preserves attempt history")
        try check(store.status(config: config()).lastCapturedRowID == 3, "review never resets capture fence")
        try check(store.status(config: config()).acknowledgedCount == 0, "local decision is not server acknowledgement")
        try rejects("old snapshot cannot contradict completed retry") { _ = try session.decide(first, action: .notPayment, confirmedNotPayment: true) }
        let remaining = try session.list().alerts
        try check(remaining.count == 1 && remaining[0].message.guid == message(2).guid, "retry does not select or change next event")
        try rejects("ignore requires explicit confirmation") { _ = try session.decide(remaining[0], action: .notPayment) }
        try check(session.decide(remaining[0], action: .notPayment, confirmedNotPayment: true) == .applied, "confirmed nonpayment removes local payload")
        try check(session.decide(remaining[0], action: .notPayment, confirmedNotPayment: true) == .alreadyApplied, "repeated ignore is idempotent")
        try check(store.db.scalarInt("select count(*) from pending where guid=?", [.text(message(2).guid)]) == 0, "ignored payload removed")
        try check(store.db.scalarInt("select count(*) from seen where guid=? and acknowledged_at is null", [.text(message(2).guid)]) == 1, "ignore retains dedupe without false receipt")
        _ = try store.capture(CaptureBatch(messages: [CapturedMessage(rowID: 4, guid: message(2).guid, sender: message(2).sender, body: message(2).body, receivedAt: message(2).receivedAt, service: "SMS")], lastRowID: 4, hasMore: false), config: config())
        try check(store.status(config: config()).pendingCount == 1, "ignored source cannot requeue from recapture")
        try check(store.status(config: config()).sourceQuarantineCount == 1, "unreadable quarantine preserved")
        try check(store.db.scalarInt("select count(*) from held_review_audit") == 3, "one audit per distinct decision")
        try check(store.db.scalarInt("select count(*) from pragma_table_info('held_review_audit') where name in ('body','sender','key','received_at','guid')") == 0, "audit excludes raw alert and key fields")
        try check(store.db.scalarInt("pragma secure_delete") == 1, "local payload deletion uses private secure-delete database")
        try rejects("review audit connection cannot be rebound to another owner") {
            _ = try store.heldAlerts(config: config(), binding: binding(otherIdentity))
        }
    }
}
private func testIsolationAndStaleActions() throws {
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshot = try session.list().alerts[0]
        try rejects("different owner cannot decide another owner snapshot") {
            _ = try store.resolveHeldAlert(snapshot, action: .tryAgain, config: config(), binding: binding(otherIdentity))
        }
        try rejects("changed key cannot read previous held payload") {
            _ = try store.heldAlerts(config: config("y"), binding: binding(config: config("y")))
        }
        try rejects("changed sender scope cannot read previous held payload") {
            _ = try store.heldAlerts(config: config(senders: ["hubtel"]), binding: binding(config: config(senders: ["hubtel"])))
        }
        try check(store.status(config: config()).heldForReviewCount == 2, "rejected cross-account decisions preserve alerts")
        try replaceBinding(binding(otherIdentity), directory: root)
        try rejects("window detects changed account file") { _ = try session.decide(snapshot, action: .tryAgain) }
        try rejects("window detects changed account before showing more text") { _ = try session.list() }
        try replaceBinding(binding(), directory: root)
        let lock = try CollectorLock(directory: root)
        try rejects("review cannot race active collector") { _ = try session.decide(snapshot, action: .tryAgain) }
        withExtendedLifetime(lock) {}
    }
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshot = try session.list().alerts[0]
        // Simulate an independent successful, already authorized delivery after
        // the window loaded. A stale review must never erase its receipt.
        try store.acknowledge(snapshot.message.guid, config: config(), at: time.addingTimeInterval(10))
        try rejects("stale ignore does not erase existing receipt") { _ = try session.decide(snapshot, action: .notPayment, confirmedNotPayment: true) }
        try check(store.status(config: config()).acknowledgedCount == 1, "prior acknowledgement preserved")
        try check(store.status(config: config()).heldForReviewCount == 1, "stale action does not mutate next alert")
        try check(store.db.scalarInt("select count(*) from sqlite_master where name='held_review_audit'") == 0, "failed action rolls back additive ledger")
    }
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshot = try session.list().alerts[0]
        try store.db.execute("update pending set body='Fictional changed GHS 999' where guid=?", [.text(snapshot.message.guid)])
        try rejects("changed text cannot be acted on via old window") { _ = try session.decide(snapshot, action: .tryAgain) }
        try check(store.status(config: config()).heldForReviewCount == 2, "changed payload stays held")
    }
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshot = try session.list().alerts[0]
        try store.db.execute("update pending set attempts=attempts+1 where guid=?", [.text(snapshot.message.guid)])
        try rejects("changed delivery attempt invalidates snapshot") { _ = try session.decide(snapshot, action: .tryAgain) }
        try check(store.status(config: config()).heldForReviewCount == 2, "stale attempts do not release alert")
    }
}
private func testPrivacy() throws {
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshot = try session.list().alerts[0]
        _ = try session.decide(snapshot, action: .later)
        var info = stat()
        try check(lstat(root.appendingPathComponent("outbox.sqlite").path, &info) == 0 && info.st_mode & 0o077 == 0, "review ledger stays in private outbox")
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: root.appendingPathComponent("account.json").path)
        try rejects("public-readable binding blocks subsequent review") { _ = try session.list() }
        try rejects("public-readable binding blocks decisions") { _ = try session.decide(snapshot, action: .tryAgain) }
        try check(store.status(config: config()).heldForReviewCount == 2, "permission failure leaves held alerts intact")
    }
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshot = try session.list().alerts[0]
        _ = try session.decide(snapshot, action: .later)
        try replaceBinding(binding(otherIdentity), directory: root)
        let changed = try HeldAlertReviewSession(directory: root)
        try rejects("new window cannot disclose another review owner's alerts") { _ = try changed.list() }
        try check(store.status(config: config()).heldForReviewCount == 2, "rebound connection does not alter original queue")
    }
    try fixture { store, root in
        let session = try HeldAlertReviewSession(directory: root)
        let snapshots = try session.list().alerts
        _ = try session.decide(snapshots[0], action: .later)
        // A failed audit insert must roll back the preceding payload change.
        try store.db.execute("create trigger fixture_audit_failure before insert on held_review_audit begin select raise(abort,'fixture'); end")
        try rejects("audit failure rolls back removal") {
            _ = try session.decide(snapshots[1], action: .notPayment, confirmedNotPayment: true)
        }
        try check(store.status(config: config()).heldForReviewCount == 2 && store.status(config: config()).pendingCount == 2, "audit failure preserves payload and held status")
        try check(store.db.scalarInt("select count(*) from held_review_audit") == 1, "failed audit leaves no partial decision")
    }
}

private func testBoundedPagination() throws {
    try fixture { store, root in
        let extra = (4...106).map { message(Int64($0)) }
        _ = try store.capture(CaptureBatch(messages: extra, lastRowID: 106, hasMore: false), config: config())
        for item in extra { try store.holdForReview(item.guid, config: config()) }
        let session = try HeldAlertReviewSession(directory: root)
        let first = try session.list()
        try check(first.heldCount == 105 && first.alerts.count == 100, "first held page is bounded")
        for item in first.alerts { _ = try session.decide(item, action: .later) }
        let second = try session.list(afterRowID: first.alerts.last!.localRowID)
        try check(second.alerts.count == 5 && Set(first.alerts.map(\.eventHash)).isDisjoint(with: second.alerts.map(\.eventHash)), "deferring first hundred keeps later alerts reachable")
        try check(second.heldCount == 105, "pagination and later do not drop held alerts")
        let refreshed = try session.list()
        try check(refreshed.alerts.first?.eventHash == first.alerts.first?.eventHash, "refresh includes saved-for-later alerts")
        try rejects("negative cursor refused") { _ = try session.list(afterRowID: -1) }
    }
}

@main struct HeldReviewTests {
    static func main() {
        do {
            try testDecisions(); try testIsolationAndStaleActions(); try testPrivacy(); try testBoundedPagination()
            print("PASS: \(checks) synthetic held-alert review assertions; no Messages, network, credentials, app launch or service activation.")
        } catch let error as ReviewFixtureFailure { fputs("FAIL: \(error.label)\n", stderr); exit(1) }
        catch { fputs("FAIL: synthetic held-alert review operation; no private values logged.\n", stderr); exit(1) }
    }
}
