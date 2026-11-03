import Foundation
import SQLite3

// Private, local-only review values. Deliberately not Encodable: text and
// account identifiers must not accidentally enter status output or diagnostics.
struct HeldAlertSnapshot {
    let localRowID: Int64
    let message: PendingMessage
    let fingerprint: String
    let heldAt: String
    let ownerID: String
    let credentialHash: String
    let senderScope: String

    var eventHash: String { digest(message.guid) }
    func actionToken(_ action: HeldAlertAction) -> String {
        digest([ownerID, credentialHash, senderScope, eventHash, fingerprint,
                heldAt, String(message.attempts), action.rawValue].joined(separator: "\u{0}"))
    }
}
enum HeldAlertAction: String { case tryAgain = "retry", notPayment = "not_payment", later = "later" }
enum HeldAlertActionResult { case applied, alreadyApplied }
struct HeldAlertList {
    let identity: CollectorAccountIdentity
    let alerts: [HeldAlertSnapshot]
    let heldCount: Int64
    let unreadableCount: Int64
    let otherSourceIssueCount: Int64
}

extension OutboxStore {
    func heldAlerts(config: CollectorConfig, binding: CollectorAccountBinding, limit: Int = 100, afterRowID: Int64 = 0) throws -> [HeldAlertSnapshot] {
        try config.validate(); try binding.validate(config: config)
        let activation = try baseline(config: config)
        try validateReviewConnectionIfPresent(config: config, binding: binding)
        guard limit > 0 && limit <= 100, afterRowID >= 0, let since = parseStamp(activation.initializedAt) else {
            throw CollectorError("The saved alert list could not be checked. Nothing was changed.")
        }
        let s = try db.prepare("select p.guid,p.sender,p.body,p.received_at,p.attempts,s.fingerprint,p.held_at,s.acknowledged_at,p.rowid from pending p join seen s on s.guid=p.guid where p.held_at is not null and p.rowid>? order by p.rowid limit ?", [.integer(afterRowID), .integer(Int64(limit))])
        defer { sqlite3_finalize(s) }
        var result: [HeldAlertSnapshot] = []
        while true {
            let step = sqlite3_step(s); if step == SQLITE_DONE { return result }
            guard step == SQLITE_ROW, let guid = columnText(s, 0), let sender = columnText(s, 1),
                  let body = columnText(s, 2), let receivedAt = columnText(s, 3),
                  let fingerprint = columnText(s, 5), let heldAt = columnText(s, 6),
                  let received = parseStamp(receivedAt), received >= since, parseStamp(heldAt) != nil,
                  columnText(s, 7) == nil, sqlite3_column_int64(s, 4) >= 1 else {
                throw CollectorError("A saved alert changed or could not be checked. Nothing was changed.")
            }
            let captured = CapturedMessage(rowID: 0, guid: guid, sender: sender, body: body, receivedAt: receivedAt, service: "SMS")
            guard try eligible(captured, config: config), captured.fingerprint == fingerprint else {
                throw CollectorError("A saved alert does not match this connection. Nothing was changed.")
            }
            result.append(HeldAlertSnapshot(localRowID: sqlite3_column_int64(s, 8), message: PendingMessage(guid: guid, sender: sender, body: body,
                receivedAt: receivedAt, attempts: sqlite3_column_int64(s, 4)), fingerprint: fingerprint,
                heldAt: heldAt, ownerID: binding.identity.ownerId, credentialHash: config.credentialHash,
                senderScope: scopeJSON(config)))
        }
    }

    // Called only by an explicit local review action. This additive, transactional
    // review ledger leaves the v3 capture/delivery schema and baseline intact.
    // A missing/corrupt/incompatible capture schema still fails in OutboxStore.
    private func validateReviewConnectionIfPresent(config: CollectorConfig, binding: CollectorAccountBinding) throws {
        if try db.scalarInt("select count(*) from sqlite_master where type='table' and name='held_review_account'") == 0 { return }
        guard try db.scalarInt("select count(*) from held_review_account where singleton=1 and owner_id=? and credential_hash=? and sender_scope=?",
            [.text(binding.identity.ownerId), .text(config.credentialHash), .text(scopeJSON(config))]) == 1 else {
            throw CollectorError("The saved alert review belongs to a different connection. Nothing was changed.")
        }
    }
    private func prepareReviewLedger(config: CollectorConfig, binding: CollectorAccountBinding) throws {
        try db.execute("create table if not exists held_review_account (singleton integer primary key check(singleton=1), owner_id text not null, credential_hash text not null, sender_scope text not null)")
        try db.execute("create table if not exists held_review_audit (token text primary key, owner_id text not null, event_hash text not null, fingerprint text not null, held_at text not null, attempts integer not null, action text not null check(action in ('retry','not_payment','later')), decided_at text not null)")
        try db.execute("insert or ignore into held_review_account values (1,?,?,?)", [.text(binding.identity.ownerId), .text(config.credentialHash), .text(scopeJSON(config))])
        try validateReviewConnectionIfPresent(config: config, binding: binding)
    }

    func resolveHeldAlert(_ snapshot: HeldAlertSnapshot, action: HeldAlertAction,
                          confirmedNotPayment: Bool = false, config: CollectorConfig,
                          binding: CollectorAccountBinding, at date: Date = Date()) throws -> HeldAlertActionResult {
        try config.validate(); try binding.validate(config: config)
        guard snapshot.ownerID == binding.identity.ownerId, snapshot.credentialHash == config.credentialHash,
              snapshot.senderScope == scopeJSON(config), action != .notPayment || confirmedNotPayment else {
            throw CollectorError("Confirm this alert and account before changing it. Nothing was changed.")
        }
        return try db.transaction {
            _ = try baseline(config: config)
            try prepareReviewLedger(config: config, binding: binding)
            let token = snapshot.actionToken(action)
            if try db.scalarInt("select count(*) from held_review_audit where token=? and owner_id=? and event_hash=? and fingerprint=? and held_at=? and attempts=? and action=?",
                [.text(token), .text(snapshot.ownerID), .text(snapshot.eventHash), .text(snapshot.fingerprint),
                 .text(snapshot.heldAt), .integer(snapshot.message.attempts), .text(action.rawValue)]) == 1 { return .alreadyApplied }

            // Re-read the exact held event inside the same transaction. A timer,
            // acknowledgement, previous decision, or changed text invalidates
            // an old window; never substitute the next event in the list.
            let s = try db.prepare("select p.sender,p.body,p.received_at,p.attempts,p.held_at,s.fingerprint,s.acknowledged_at from pending p join seen s on s.guid=p.guid where p.guid=?", [.text(snapshot.message.guid)])
            defer { sqlite3_finalize(s) }
            guard sqlite3_step(s) == SQLITE_ROW, columnText(s, 0) == snapshot.message.sender,
                  columnText(s, 1) == snapshot.message.body, columnText(s, 2) == snapshot.message.receivedAt,
                  sqlite3_column_int64(s, 3) == snapshot.message.attempts, columnText(s, 4) == snapshot.heldAt,
                  columnText(s, 5) == snapshot.fingerprint, columnText(s, 6) == nil else {
                throw CollectorError("This alert has changed since you opened it. Refresh the list before deciding.")
            }
            let captured = CapturedMessage(rowID: 0, guid: snapshot.message.guid, sender: snapshot.message.sender,
                body: snapshot.message.body, receivedAt: snapshot.message.receivedAt, service: "SMS")
            guard try eligible(captured, config: config), captured.fingerprint == snapshot.fingerprint else {
                throw CollectorError("This alert could not be checked. Nothing was changed.")
            }
            switch action {
            case .tryAgain:
                // Same GUID, body and receipt identity. This queues no network
                // operation; future approved delivery still checks the account.
                try db.execute("update pending set held_at=null,last_error_code=null where guid=?", [.text(snapshot.message.guid)])
            case .notPayment:
                // Keep seen/fingerprint deduplication. Do not claim an Alfred
                // acknowledgement, erase a server record, or recreate this SMS.
                try db.execute("delete from pending where guid=?", [.text(snapshot.message.guid)])
            case .later: break
            }
            try db.execute("insert into held_review_audit values (?,?,?,?,?,?,?,?)", [.text(token), .text(snapshot.ownerID),
                .text(snapshot.eventHash), .text(snapshot.fingerprint), .text(snapshot.heldAt),
                .integer(snapshot.message.attempts), .text(action.rawValue), .text(stamp(date))])
            return .applied
        }
    }
}

// The explicit review window is local-only. Re-read private configuration and
// account binding for every action rather than trusting a stale displayed name.
// Remote account freshness is deliberately not claimed; later delivery has its
// existing independent authenticated account check.
final class HeldAlertReviewSession {
    let directory: URL
    let identity: CollectorAccountIdentity
    private let credentialHash: String
    private let senderScope: String
    init(directory: URL) throws {
        try ensurePrivateDirectory(directory)
        let config = try loadConfig(directory)
        let binding = try loadAccountBinding(directory: directory, config: config)
        self.directory = directory; identity = binding.identity
        credentialHash = config.credentialHash; senderScope = scopeJSON(config)
    }
    private func connection() throws -> (CollectorConfig, CollectorAccountBinding) {
        try ensurePrivateDirectory(directory)
        let config = try loadConfig(directory)
        let binding = try loadAccountBinding(directory: directory, config: config)
        guard binding.identity.ownerId == identity.ownerId, config.credentialHash == credentialHash,
              scopeJSON(config) == senderScope else {
            throw CollectorError("The account connection changed. Close this window and check your connection.")
        }
        return (config, binding)
    }
    func list(afterRowID: Int64 = 0) throws -> HeldAlertList {
        try ensurePrivateDirectory(directory)
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        let (config, binding) = try connection()
        let store = try OutboxStore(directory: directory, readOnly: true)
        let status = try store.status(config: config)
        return try HeldAlertList(identity: binding.identity, alerts: store.heldAlerts(config: config, binding: binding, afterRowID: afterRowID),
            heldCount: status.heldForReviewCount, unreadableCount: status.unreadableSourceCount,
            otherSourceIssueCount: status.sourceQuarantineCount - status.unreadableSourceCount)
    }
    func decide(_ snapshot: HeldAlertSnapshot, action: HeldAlertAction, confirmedNotPayment: Bool = false) throws -> HeldAlertActionResult {
        try ensurePrivateDirectory(directory)
        let lock = try CollectorLock(directory: directory); defer { withExtendedLifetime(lock) {} }
        let (config, binding) = try connection()
        let store = try OutboxStore(directory: directory)
        return try store.resolveHeldAlert(snapshot, action: action, confirmedNotPayment: confirmedNotPayment,
            config: config, binding: binding)
    }
}
