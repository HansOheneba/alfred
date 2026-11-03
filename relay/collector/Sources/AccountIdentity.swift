import Foundation
import CoreFoundation
import Darwin

let collectorAccountURL = URL(string: "https://alfred.hansopoku.com/api/collector/account")!
struct CollectorAccountIdentity: Codable, Equatable {
    let ownerId: String
    let preferredName: String
    let email: String
    func validate() throws {
        let unsafe = CharacterSet.controlCharacters.union(.whitespacesAndNewlines)
        guard let uuid = UUID(uuidString: ownerId), uuid.uuidString.lowercased() == ownerId,
              !preferredName.isEmpty, preferredName.count <= 80,
              !preferredName.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .format }),
              email.count <= 254, email.range(of: "^[^\\s<>@]+@[^\\s<>@]+\\.[^\\s<>@]+$", options: .regularExpression) != nil,
              !email.unicodeScalars.contains(where: { unsafe.contains($0) || $0.properties.generalCategory == .format }) else {
            throw CollectorError("The account identity could not be verified. No Messages access or delivery is allowed.")
        }
    }
}
struct CollectorAccountBinding: Codable {
    let version: Int
    let identity: CollectorAccountIdentity
    let credentialHash: String
    let confirmedAt: String
    func validate(config: CollectorConfig) throws {
        try identity.validate()
        guard version == 1, credentialHash == config.credentialHash, parseStamp(confirmedAt) != nil else {
            throw CollectorError("The saved account connection does not match this key. Stop and review the account connection; no automatic migration is allowed.")
        }
    }
}
private struct AccountResponse: Decodable { let ok: Bool; let identityProtocol: Int; let account: CollectorAccountIdentity }
func decodeAccountIdentity(status: Int?, data: Data?, networkError: Bool) throws -> CollectorAccountIdentity {
    guard !networkError, status == 200, let data, !data.isEmpty, data.count <= 8192,
          let result = try? JSONDecoder().decode(AccountResponse.self, from: data), result.ok, result.identityProtocol == 1 else {
        throw CollectorError("Alfred could not verify the account connection. No Messages access or delivery is allowed.")
    }
    try result.account.validate(); return result.account
}

/** A small, bounded, cookie-free identity response; redirects never receive the key. */
private final class AccountResponseDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private let completed = DispatchSemaphore(value: 0)
    private var bytes = Data()
    private var status: Int?
    private var failed = false
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        lock.lock(); status = (response as? HTTPURLResponse)?.statusCode
        let allowed = status == 200 && response.expectedContentLength <= 8192
        if !allowed { failed = true }
        lock.unlock(); completionHandler(allowed ? .allow : .cancel)
    }
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        if bytes.count + data.count > 8192 { failed = true; lock.unlock(); dataTask.cancel(); return }
        bytes.append(data); lock.unlock()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock(); failed = failed || error != nil; lock.unlock(); completed.signal()
    }
    func result() throws -> CollectorAccountIdentity {
        guard completed.wait(timeout: .now() + 20) == .success else { throw CollectorError("The account connection check timed out. Nothing was collected or sent.") }
        lock.lock(); defer { lock.unlock() }
        return try decodeAccountIdentity(status: status, data: bytes, networkError: failed)
    }
}
func fetchCollectorAccount(key: String) throws -> CollectorAccountIdentity {
    var request = URLRequest(url: collectorAccountURL)
    request.httpMethod = "GET"; request.timeoutInterval = 12
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let settings = URLSessionConfiguration.ephemeral
    settings.urlCache = nil; settings.httpCookieStorage = nil; settings.httpShouldSetCookies = false
    settings.urlCredentialStorage = nil
    settings.requestCachePolicy = .reloadIgnoringLocalCacheData
    settings.timeoutIntervalForRequest = 12; settings.timeoutIntervalForResource = 15
    let delegate = AccountResponseDelegate()
    let session = URLSession(configuration: settings, delegate: delegate, delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    session.dataTask(with: request).resume()
    return try delegate.result()
}
func loadAccountBinding(directory: URL, config: CollectorConfig) throws -> CollectorAccountBinding {
    let binding: CollectorAccountBinding
    do { binding = try JSONDecoder().decode(CollectorAccountBinding.self, from: readPrivate(directory.appendingPathComponent("account.json"))) }
    catch { throw CollectorError("Connect and confirm the intended Alfred account first. Existing configuration and baseline have not been changed.") }
    try binding.validate(config: config); return binding
}
func saveNewAccountBinding(_ binding: CollectorAccountBinding, directory: URL, config: CollectorConfig) throws {
    try binding.validate(config: config); try ensurePrivateDirectory(directory)
    let url = directory.appendingPathComponent("account.json")
    let fd = open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw CollectorError("An account connection already exists or could not be saved. Nothing was overwritten.") }
    var success = false
    defer { close(fd); if !success { unlink(url.path) } }
    let data = try JSONEncoder().encode(binding)
    try data.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let written = write(fd, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if written < 0 && errno == EINTR { continue }
            guard written > 0 else { throw CollectorError("The account connection could not be saved.") }; offset += written
        }
    }
    guard fsync(fd) == 0 else { throw CollectorError("The account connection could not be flushed.") }; success = true
}
func verifiedAccountBinding(config: CollectorConfig, directory: URL,
                            lookup: (String) throws -> CollectorAccountIdentity = fetchCollectorAccount) throws -> CollectorAccountBinding {
    let binding = try loadAccountBinding(directory: directory, config: config)
    let current = try lookup(config.key); try current.validate()
    guard current.ownerId == binding.identity.ownerId else {
        throw CollectorError("Alfred returned a different account. Messages access and delivery are blocked; review the account connection.")
    }
    return binding
}
/** Confirmation is explicit and defaults to cancellation; never a yes flag or background prompt. */
func confirmedAccount(key: String, lookup: (String) throws -> CollectorAccountIdentity = fetchCollectorAccount,
                      confirm: (CollectorAccountIdentity) throws -> Bool) throws -> CollectorAccountIdentity {
    let identity = try lookup(key); try identity.validate()
    guard try confirm(identity) else { throw CollectorError("Account connection cancelled. No Messages were read or sent.") }
    return identity
}
