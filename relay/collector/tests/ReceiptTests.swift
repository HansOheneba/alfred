import Foundation

let fixtureReceiptOwner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
func durableReceiptData(_ item: PendingMessage, disposition: String = "stored", patch: [String: Any] = [:]) throws -> Data {
    var receipt: [String: Any] = ["version": 2, "eventId": collectorEventID(item), "ownerId": fixtureReceiptOwner,
        "payloadHash": collectorPayloadHash(item), "receiptId": "11111111-1111-4111-8111-111111111111", "disposition": disposition]
    patch.forEach { receipt[$0.key] = $0.value }
    return try JSONSerialization.data(withJSONObject: ["ok": true, "found": 0, "duplicates": 0, "needsLabel": 0, "collectorReceipt": receipt])
}
func testDurableReceipts() throws {
    let item = PendingMessage(guid: "fixture-guid", sender: "mobilemoney", body: "Fixture GHS 25 👩🏽‍💻 e\u{301}", receivedAt: stamp(epoch.addingTimeInterval(1)), attempts: 0)
    func read(_ data: Data?, status: Int = 200) -> DeliveryDecision {
        classifyAcknowledgement(status: status, data: data, networkError: false, expectedEventId: collectorEventID(item), expectedOwnerId: fixtureReceiptOwner, expectedPayloadHash: collectorPayloadHash(item))
    }
    for legacy in ["{\"ok\":true,\"found\":0,\"duplicates\":0,\"needsLabel\":0}", "{\"ok\":true,\"found\":1,\"duplicates\":0,\"needsLabel\":0}"] {
        try expect(read(Data(legacy.utf8)) == .retry("invalid_ack"), "legacy counters never authorize payload deletion")
    }
    try expect(read(durableReceiptData(item)) == .accepted, "matching durable receipt accepted even when legacy counters are zero")
    try expect(read(durableReceiptData(item, disposition: "duplicate")) == .accepted, "lost acknowledgement retry accepts matching duplicate receipt")
    for patch: [String: Any] in [["version": true], ["version": 1], ["eventId": digest("other event")], ["ownerId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], ["payloadHash": digest("different payload")], ["receiptId": "not-a-receipt"], ["disposition": "ignored"]] {
        try expect(read(durableReceiptData(item, patch: patch)) == .retry("invalid_ack"), "mismatched or non-durable disposition retained")
    }
    try expect(read(durableReceiptData(item, disposition: "pending_review"), status: 202) == .retry("review_required"), "unrecognized alert explicitly held for review")
    try expect(read(durableReceiptData(item, disposition: "pending_review", patch: ["ownerId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]), status: 202) == .retry("invalid_ack"), "foreign review response does not change local disposition")
    try expect(read(Data(repeating: 0x20, count: 16385)) == .retry("invalid_ack"), "oversize acknowledgement rejected")
    try expect(collectorPayloadHash(item) == "cc36e7193b022e3175fcc21d5aca36f8465f944d3bc3f8c1a1ce1f8e3a6090d7", "UTF8 protocol fingerprint matches backend fixture")
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages: [message(1), message(2)], lastRowID: 2, hasMore: false), config: config())
        var attempted: [String] = []
        let accepted = try deliverPending(store: store, config: config()) { pending, _ in
            attempted.append(pending.guid)
            return pending.guid == "fixture-guid-1" ? .retry("review_required") : .accepted
        }
        let status = try store.status(config: config())
        try expect(accepted == 1 && attempted == ["fixture-guid-1", "fixture-guid-2"], "held unknown alert never blocks an independent later event")
        try expect(status.pendingCount == 1 && status.heldForReviewCount == 1 && status.acknowledgedCount == 1, "held alert retains raw payload without false acknowledgement")
        try expect(store.db.scalarInt("select count(*) from pending where body is not null") == 1, "unrecognized body remains privately stored")
        try expect(deliverPending(store: store, config: config()) { _, _ in throwawayTransport() } == 0, "held alert is not automatically retried")
        let safeStatus = String(data: try JSONEncoder().encode(status), encoding: .utf8)!
        try expect(!safeStatus.contains("Fixture") && !safeStatus.contains(config().key) && !safeStatus.contains("fixture-guid"), "held status contains no content, key or event ID")
    }
    try withStore { store, _ in
        _ = try store.capture(CaptureBatch(messages: [message(1)], lastRowID: 1, hasMore: false), config: config())
        try store.db.execute("create trigger fixture_hold_failure before update of held_at on pending begin select raise(abort,'fixture failure'); end")
        try expectError("failed hold commit retains pending payload") { _ = try deliverPending(store: store, config: config()) { _, _ in .retry("review_required") } }
        try expect(store.status(config: config()).pendingCount == 1 && store.status(config: config()).heldForReviewCount == 0, "failed hold transition rolls back without loss")
    }
}
private func throwawayTransport() -> DeliveryDecision { fatalError("Held alert must never reach a transport") }
