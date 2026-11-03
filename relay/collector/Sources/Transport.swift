import Foundation
import CoreFoundation

let alfredSMSURL = URL(string: "https://alfred.hansopoku.com/api/ingest/sms")!
enum DeliveryDecision: Equatable { case accepted; case retry(String) }
func collectorEventID(_ message: PendingMessage) -> String { digest(message.guid) }
func collectorPayloadHash(_ message: PendingMessage) -> String { digest("v2\0" + message.sender + "\0" + message.receivedAt + "\0" + message.body) }
func classifyAcknowledgement(status: Int?, data: Data?, networkError: Bool,
    expectedEventId: String? = nil, expectedOwnerId: String? = nil, expectedPayloadHash: String? = nil) -> DeliveryDecision {
    guard !networkError, let status else { return .retry("network") }
    guard (200..<300).contains(status) else { return .retry((100...599).contains(status) ? "http_\(status)" : "network") }
    guard let expectedEventId, let expectedOwnerId, let expectedPayloadHash,
          expectedEventId.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          expectedPayloadHash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          UUID(uuidString: expectedOwnerId) != nil,
          let data, data.count <= 16384, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ok = json["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue,
          let receipt = json["collectorReceipt"] as? [String: Any],
          let version = receipt["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 2,
          receipt["eventId"] as? String == expectedEventId,
          (receipt["ownerId"] as? String)?.lowercased() == expectedOwnerId.lowercased(),
          receipt["payloadHash"] as? String == expectedPayloadHash,
          let disposition = receipt["disposition"] as? String else { return .retry("invalid_ack") }
    if disposition == "pending_review" { return .retry("review_required") }
    guard ["stored", "duplicate"].contains(disposition), let receiptID = receipt["receiptId"] as? String,
          UUID(uuidString: receiptID) != nil else { return .retry("invalid_ack") }
    return .accepted
}
final class RefuseRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
private final class DecisionBox: @unchecked Sendable {
    private let lock = NSLock(); private var decision: DeliveryDecision = .retry("network")
    func set(_ value: DeliveryDecision) { lock.lock(); decision = value; lock.unlock() }
    func get() -> DeliveryDecision { lock.lock(); defer { lock.unlock() }; return decision }
}
func deliverHTTP(_ message: PendingMessage, key: String, expectedOwnerId: String) -> DeliveryDecision {
    // Never truncate a captured alert and then delete the original on an ACK.
    guard !message.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          message.body.utf16.count <= 4000, !message.sender.isEmpty, message.sender.utf16.count <= 80,
          UUID(uuidString: expectedOwnerId) != nil else { return .retry("encoding") }
    var request = URLRequest(url: alfredSMSURL)
    request.httpMethod = "POST"; request.timeoutInterval = 30
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.setValue(expectedOwnerId.lowercased(), forHTTPHeaderField: "X-Alfred-Collector-Owner")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    do { request.httpBody = try JSONSerialization.data(withJSONObject: ["protocol": 2, "eventId": collectorEventID(message), "text": message.body, "sender": message.sender, "receivedAt": message.receivedAt, "source": "mac"]) }
    catch { return .retry("encoding") }
    let settings = URLSessionConfiguration.ephemeral
    settings.urlCache = nil; settings.httpCookieStorage = nil; settings.httpShouldSetCookies = false
    settings.requestCachePolicy = .reloadIgnoringLocalCacheData
    settings.timeoutIntervalForRequest = 30; settings.timeoutIntervalForResource = 35
    let session = URLSession(configuration: settings, delegate: RefuseRedirects(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let done = DispatchSemaphore(value: 0); let box = DecisionBox()
    let task = session.dataTask(with: request) { data, response, error in
        box.set(classifyAcknowledgement(status: (response as? HTTPURLResponse)?.statusCode, data: data, networkError: error != nil,
            expectedEventId: collectorEventID(message), expectedOwnerId: expectedOwnerId, expectedPayloadHash: collectorPayloadHash(message))); done.signal()
    }
    task.resume()
    guard done.wait(timeout: .now() + 40) == .success else { task.cancel(); return .retry("network") }
    return box.get()
}
@discardableResult func deliverPending(store: OutboxStore, config: CollectorConfig,
    maxMessages: Int = 3, elapsedBudget: TimeInterval = 90,
    clock: () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    transport: (PendingMessage, String) -> DeliveryDecision) throws -> Int {
    // One scheduled cycle must leave time for the next 120-second collection.
    // The HTTP implementation waits at most 40 seconds; never start another
    // request unless that complete window remains in this bounded batch.
    guard (1...3).contains(maxMessages), elapsedBudget.isFinite, (0...90).contains(elapsedBudget) else {
        throw CollectorError("Delivery batch exceeds the permitted count/time budget.")
    }
    let started = clock()
    guard started.isFinite else { throw CollectorError("Delivery clock unavailable; no request attempted.") }
    let deadline = started + elapsedBudget
    var accepted = 0
    for item in try store.pending(config: config, limit: maxMessages) {
        let now = clock()
        guard now.isFinite, now >= started else { throw CollectorError("Delivery clock changed unexpectedly; remaining payloads retained.") }
        if deadline - now < 40 { break }
        switch transport(item, config.key) {
        case .accepted: try store.acknowledge(item.guid, config: config); accepted += 1
        case .retry(let code):
            if code == "review_required" {
                try store.holdForReview(item.guid, config: config)
                continue
            }
            try store.recordFailure(item.guid, code: code, config: config)
            throw CollectorError("Delivery held for retry (\(code)); pending payload retained. No content or credential logged.")
        }
    }
    return accepted
}
