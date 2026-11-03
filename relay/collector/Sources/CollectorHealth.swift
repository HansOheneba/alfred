import Foundation
import CoreFoundation
import Darwin

let collectorHealthURL = URL(string: "https://alfred.hansopoku.com/api/collector/health")!
struct CollectorHealthDevice: Codable {
    let version: Int
    let deviceId: String
    let ownerId: String
    func validate(ownerId expected: String) throws {
        guard version == 1, let uuid = UUID(uuidString: deviceId), uuid.uuidString.lowercased() == deviceId,
              UUID(uuidString: ownerId) != nil, ownerId == expected else { throw CollectorError("The Mac status identifier needs an approved account setup review.") }
    }
}
func loadCollectorHealthDevice(directory: URL, ownerId: String) throws -> CollectorHealthDevice {
    let device: CollectorHealthDevice
    do { device = try JSONDecoder().decode(CollectorHealthDevice.self, from: readPrivate(directory.appendingPathComponent("health-device.json"))) }
    catch { throw CollectorError("The Mac status identifier is unavailable. Confirm the account setup before status reporting.") }
    try device.validate(ownerId: ownerId); return device
}
/** Only a future, explicitly confirmed setup calls this; collection never creates an ID. */
@discardableResult func prepareCollectorHealthDevice(directory: URL, ownerId: String, makeID: () -> UUID = { UUID() }) throws -> CollectorHealthDevice {
    let url = directory.appendingPathComponent("health-device.json")
    if try pathExists(url) { return try loadCollectorHealthDevice(directory: directory, ownerId: ownerId) }
    guard UUID(uuidString: ownerId) != nil else { throw CollectorError("The confirmed account identity is invalid.") }
    let device = CollectorHealthDevice(version: 1, deviceId: makeID().uuidString.lowercased(), ownerId: ownerId)
    try device.validate(ownerId: ownerId); try ensurePrivateDirectory(directory)
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CollectorError("The Mac status identifier could not be saved; no existing identifier was overwritten.") }
    var saved = false
    defer { close(fd); if !saved { unlink(url.path) } }
    let data = try JSONEncoder().encode(device)
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw CollectorError("The Mac status identifier could not be persisted.") }; offset += count
        }
    }
    guard fsync(fd) == 0 else { throw CollectorError("The Mac status identifier could not be flushed.") }; saved = true
    return device
}
enum CollectorHealthState: String, Codable { case ready; case needsReview = "needs_review"; case captureError = "capture_error" }
struct CollectorHealthCounts: Codable {
    let sourceQuarantine: Int64
    let unreadable: Int64
    let incomplete: Int64
    let heldForReview: Int64
    let pending: Int64
    func validate() throws {
        guard [sourceQuarantine, unreadable, incomplete, heldForReview, pending].allSatisfy({ (0...1_000_000).contains($0) }),
              unreadable + incomplete <= sourceQuarantine, heldForReview <= pending else { throw CollectorError("Mac status counts are outside the permitted bounds.") }
    }
}
struct CollectorHealthReport: Codable {
    let version: Int
    let deviceId: String
    let state: CollectorHealthState
    let counts: CollectorHealthCounts
    let lastSuccessfulCaptureAt: String?
    let lastAcceptedAt: String?
    private enum CodingKeys: String, CodingKey { case version, deviceId, state, counts, lastSuccessfulCaptureAt, lastAcceptedAt }
    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(version, forKey: .version); try values.encode(deviceId, forKey: .deviceId)
        try values.encode(state, forKey: .state); try values.encode(counts, forKey: .counts)
        if let date = lastSuccessfulCaptureAt { try values.encode(date, forKey: .lastSuccessfulCaptureAt) } else { try values.encodeNil(forKey: .lastSuccessfulCaptureAt) }
        if let date = lastAcceptedAt { try values.encode(date, forKey: .lastAcceptedAt) } else { try values.encodeNil(forKey: .lastAcceptedAt) }
    }
    func validate(now: Date = Date()) throws {
        guard version == 1, let uuid = UUID(uuidString: deviceId), uuid.uuidString.lowercased() == deviceId else { throw CollectorError("Invalid Mac status envelope.") }
        try counts.validate()
        for value in [lastSuccessfulCaptureAt, lastAcceptedAt].compactMap({ $0 }) {
            guard let date = parseStamp(value), stamp(date) == value, date <= now.addingTimeInterval(300) else { throw CollectorError("Invalid Mac status timestamp.") }
        }
        if state == .ready {
            guard lastSuccessfulCaptureAt != nil, counts.sourceQuarantine == 0, counts.heldForReview == 0, counts.pending == 0 else { throw CollectorError("A ready Mac status cannot hide unresolved work.") }
        }
    }
}
func collectorHealthReport(device: CollectorHealthDevice, ownerId: String, status: OutboxStatus, captureFailed: Bool, now: Date = Date()) throws -> CollectorHealthReport {
    try device.validate(ownerId: ownerId)
    let counts = CollectorHealthCounts(sourceQuarantine: status.sourceQuarantineCount, unreadable: status.unreadableSourceCount,
        incomplete: status.incompleteSourceMetadataCount, heldForReview: status.heldForReviewCount, pending: status.pendingCount)
    let review = counts.sourceQuarantine > 0 || counts.heldForReview > 0 || counts.pending > 0 || status.lastSuccessfulCaptureAt == nil
    let report = CollectorHealthReport(version: 1, deviceId: device.deviceId, state: captureFailed ? .captureError : review ? .needsReview : .ready,
        counts: counts, lastSuccessfulCaptureAt: status.lastSuccessfulCaptureAt, lastAcceptedAt: status.lastAcceptedAt)
    try report.validate(now: now); return report
}
func collectorHealthRequest(report: CollectorHealthReport, key: String, ownerId: String, now: Date = Date()) throws -> URLRequest {
    try report.validate(now: now)
    guard key.range(of: "^alf_[A-Za-z0-9_-]{20,64}$", options: .regularExpression) != nil, UUID(uuidString: ownerId) != nil else { throw CollectorError("Invalid Mac status account connection.") }
    let data = try JSONEncoder().encode(report)
    guard data.count <= 4096 else { throw CollectorError("Mac status envelope exceeds its bound.") }
    var request = URLRequest(url: collectorHealthURL)
    request.httpMethod = "POST"; request.timeoutInterval = 2
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.setValue(ownerId.lowercased(), forHTTPHeaderField: "X-Alfred-Collector-Owner")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = data; return request
}
func collectorHealthAcknowledged(status: Int?, data: Data?, failed: Bool) -> Bool {
    guard !failed, status == 200, let data, data.count <= 1024,
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ok = json["ok"] as? NSNumber, CFGetTypeID(ok) == CFBooleanGetTypeID(), ok.boolValue else { return false }
    return true
}
private final class CollectorHealthResponse: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let finished = DispatchSemaphore(value: 0)
    private var bytes = Data()
    private var status: Int?
    private var failed = false
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); status = (response as? HTTPURLResponse)?.statusCode
        let allowed = status == 200 && response.expectedContentLength <= 1024
        if !allowed { failed = true }; lock.unlock(); completionHandler(allowed ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if bytes.count + data.count > 1024 { failed = true; lock.unlock(); dataTask.cancel(); return }
        bytes.append(data); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); failed = failed || error != nil; lock.unlock(); finished.signal()
    }
    func result() -> Bool {
        guard finished.wait(timeout: .now() + 4) == .success else { return false }
        lock.lock(); defer { lock.unlock() }; return collectorHealthAcknowledged(status: status, data: bytes, failed: failed)
    }
}
func postCollectorHealth(_ report: CollectorHealthReport, key: String, ownerId: String) -> Bool {
    guard let request = try? collectorHealthRequest(report: report, key: key, ownerId: ownerId) else { return false }
    let settings = URLSessionConfiguration.ephemeral
    settings.urlCache = nil; settings.httpCookieStorage = nil; settings.httpShouldSetCookies = false; settings.urlCredentialStorage = nil
    settings.requestCachePolicy = .reloadIgnoringLocalCacheData; settings.timeoutIntervalForRequest = 2; settings.timeoutIntervalForResource = 3
    let response = CollectorHealthResponse()
    let reportingSession = URLSession(configuration: settings, delegate: response, delegateQueue: nil)
    defer { reportingSession.invalidateAndCancel() }
    reportingSession.dataTask(with: request).resume(); return response.result()
}
/** Best effort only: no cursor, receipt, pending body, account or device file is changed. */
@discardableResult func reportCollectorHealthBestEffort(store: OutboxStore, config: CollectorConfig, binding: CollectorAccountBinding,
    directory: URL, captureFailed: Bool, transport: (CollectorHealthReport, String, String) -> Bool = postCollectorHealth) -> Bool {
    do {
        try binding.validate(config: config)
        let device = try loadCollectorHealthDevice(directory: directory, ownerId: binding.identity.ownerId)
        let report = try collectorHealthReport(device: device, ownerId: binding.identity.ownerId, status: store.status(config: config), captureFailed: captureFailed)
        return transport(report, config.key, binding.identity.ownerId)
    } catch { return false }
}
