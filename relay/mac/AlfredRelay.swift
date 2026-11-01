// Alfred relay for macOS: forwards new MoMo and GCB texts from the Messages
// app to Alfred. Needs "Text Message Forwarding" on the iPhone so SMS reach
// this Mac, and Full Disk Access for this binary so it can read chat.db.
//
//   alfred-relay           send anything new since the last run
//   alfred-relay --check   show what would be sent, without sending
//
// Config lives in ~/Library/Application Support/AlfredRelay/config.json:
//   { "key": "alf_…" }
//
// What it can touch is limited twice over: this code only reads chat.db and
// only sends bank texts to Alfred, and before doing anything it locks itself
// into sandbox.sb (built into the program), so macOS refuses every other file
// in your home folder and any other network use. It won't run unsandboxed.

import Foundation
import SQLite3

let support = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/AlfredRelay")
let configURL = support.appendingPathComponent("config.json")
let stateURL = support.appendingPathComponent("last-rowid")
let chatDB = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Messages/chat.db").path
let checkOnly = CommandLine.arguments.contains("--check")

/// The only place texts are sent. Not configurable, so a changed config file can't redirect them.
let endpoint = URL(string: "https://alfred.hansopoku.com/api/ingest/sms")!
/// Only money texts leave this Mac, the same filter as the iPhone automation.
let moneyPattern = try! NSRegularExpression(pattern: "\\b(GHS|GH₵|GH¢|CEDIS)", options: [.caseInsensitive])
/// On the first run, catch up on the last week. Alfred skips anything it already has.
let firstRunLookback: TimeInterval = 7 * 86_400

struct Config: Decodable {
    let key: String
}

struct Text {
    let rowid: Int64
    let body: String
    let sender: String
    let receivedAt: Date
}

func log(_ message: String) {
    let stamp = ISO8601DateFormatter().string(from: Date())
    FileHandle.standardError.write("\(stamp) \(message)\n".data(using: .utf8)!)
}

/// Newer macOS keeps the message in attributedBody (an archived NSAttributedString) and leaves text empty.
/// The string follows the "NSString" class marker, after a length prefix. Read it directly rather than
/// with NSUnarchiver, which crashes the process on data it doesn't expect.
func decodeAttributedBody(_ data: Data) -> String? {
    let bytes = [UInt8](data)
    guard let marker = data.range(of: Data("NSString".utf8)) else { return nil }
    var index = marker.upperBound - data.startIndex + 5
    guard index < bytes.count else { return nil }
    var length = Int(bytes[index])
    index += 1
    if length == 0x81, index + 2 <= bytes.count {
        length = Int(bytes[index]) | Int(bytes[index + 1]) << 8
        index += 2
    } else if length == 0x82, index + 4 <= bytes.count {
        length = Int(bytes[index]) | Int(bytes[index + 1]) << 8 | Int(bytes[index + 2]) << 16 | Int(bytes[index + 3]) << 24
        index += 4
    }
    guard length > 0, index + length <= bytes.count else { return nil }
    return String(bytes: bytes[index..<(index + length)], encoding: .utf8)
}

/// Messages stores dates as nanoseconds (or, on old databases, seconds) since 2001-01-01.
func appleDate(_ raw: Int64) -> Date {
    let seconds = raw > 1_000_000_000_000 ? Double(raw) / 1_000_000_000 : Double(raw)
    return Date(timeIntervalSinceReferenceDate: seconds)
}

func readTexts(after rowid: Int64?) throws -> [Text] {
    var db: OpaquePointer?
    guard sqlite3_open_v2(chatDB, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
        throw NSError(domain: "relay", code: 1, userInfo: [NSLocalizedDescriptionKey: "Can't open Messages. Give alfred-relay Full Disk Access in System Settings → Privacy & Security."])
    }
    defer { sqlite3_close(db) }

    var sql = """
        select m.ROWID, m.text, m.attributedBody, m.date, coalesce(h.id, '')
        from message m left join handle h on h.ROWID = m.handle_id
        where m.is_from_me = 0 and
        """
    if rowid == nil {
        sql += " m.date >= ? order by m.ROWID limit 500"
    } else {
        sql += " m.ROWID > ? order by m.ROWID limit 500"
    }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK else {
        throw NSError(domain: "relay", code: 2, userInfo: [NSLocalizedDescriptionKey: String(cString: sqlite3_errmsg(db))])
    }
    defer { sqlite3_finalize(statement) }
    if let rowid {
        sqlite3_bind_int64(statement, 1, rowid)
    } else {
        let since = Date().addingTimeInterval(-firstRunLookback).timeIntervalSinceReferenceDate
        sqlite3_bind_int64(statement, 1, Int64(since * 1_000_000_000))
    }

    var texts: [Text] = []
    while sqlite3_step(statement) == SQLITE_ROW {
        let id = sqlite3_column_int64(statement, 0)
        var body = sqlite3_column_text(statement, 1).map { String(cString: $0) } ?? ""
        if body.isEmpty, let blob = sqlite3_column_blob(statement, 2) {
            let data = Data(bytes: blob, count: Int(sqlite3_column_bytes(statement, 2)))
            body = decodeAttributedBody(data) ?? ""
        }
        let sender = String(cString: sqlite3_column_text(statement, 4))
        texts.append(Text(rowid: id, body: body, sender: sender, receivedAt: appleDate(sqlite3_column_int64(statement, 3))))
    }
    return texts
}

func isMoney(_ body: String) -> Bool {
    moneyPattern.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)) != nil
}

/// Banks and MoMo send from named sender IDs such as "MobileMoney" or "GCB Bank". People text from a
/// phone number or an email address, so their messages are never sent, even if they mention cedis.
func isFromBank(_ sender: String) -> Bool {
    !sender.contains("@") && sender.rangeOfCharacter(from: .letters) != nil
}

func shouldSend(_ text: Text) -> Bool {
    isFromBank(text.sender) && isMoney(text.body)
}

enum SendResult { case sent, rejected, retryLater }

func send(_ text: Text, config: Config) -> SendResult {
    var request = URLRequest(url: endpoint)
    request.httpMethod = "POST"
    request.timeoutInterval = 30
    request.setValue("Bearer \(config.key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: [
        "text": String(text.body.prefix(4000)),
        "sender": String(text.sender.prefix(80)),
        "source": "mac",
        "receivedAt": ISO8601DateFormatter().string(from: text.receivedAt),
    ])

    var result = SendResult.retryLater
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: request) { _, response, error in
        defer { done.signal() }
        guard error == nil, let status = (response as? HTTPURLResponse)?.statusCode else {
            log("network error for message \(text.rowid): \(error?.localizedDescription ?? "no response")")
            return
        }
        switch status {
        case 200..<300: result = .sent
        case 401: log("Alfred rejected the forwarding key. Paste a fresh one into config.json.")
        case 429, 500...: log("Alfred is busy (\(status)); will retry message \(text.rowid).")
        default:
            log("Alfred skipped message \(text.rowid) (\(status)).")
            result = .rejected
        }
    }.resume()
    done.wait()
    return result
}

@_silgen_name("sandbox_init_with_parameters")
func sandbox_init_with_parameters(_ profile: UnsafePointer<CChar>, _ flags: UInt64, _ parameters: UnsafePointer<UnsafePointer<CChar>?>, _ errorbuf: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>) -> Int32

/// Applies sandboxProfile (from sandbox.sb, compiled in by install.sh) to this process for good.
func lockDown() -> Bool {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    var error: UnsafeMutablePointer<CChar>?
    let status = home.withCString { homePath in
        "HOME".withCString { key in
            var parameters: [UnsafePointer<CChar>?] = [key, homePath, nil]
            return sandbox_init_with_parameters(sandboxProfile, 0, &parameters, &error)
        }
    }
    if status != 0 {
        log("Refusing to run: the sandbox could not be applied (\(error.map { String(cString: $0) } ?? "unknown error")).")
        return false
    }
    return true
}

func run() -> Int32 {
    guard lockDown() else { return 1 }
    let config = try? JSONDecoder().decode(Config.self, from: Data(contentsOf: configURL))
    if config == nil && !checkOnly {
        log("Missing or unreadable \(configURL.path). Run install.sh again.")
        return 1
    }

    let saved = (try? String(contentsOf: stateURL, encoding: .utf8)).flatMap { Int64($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
    let texts: [Text]
    do {
        texts = try readTexts(after: saved)
    } catch {
        log(error.localizedDescription)
        return 1
    }

    var last = saved ?? 0
    var sent = 0
    for text in texts {
        if shouldSend(text) {
            if checkOnly {
                print("[\(text.receivedAt)] \(text.sender): \(text.body.prefix(90).replacingOccurrences(of: "\n", with: " "))")
                continue
            }
            let result = send(text, config: config!)
            if case .retryLater = result { break }
            if case .sent = result { sent += 1 }
        }
        last = max(last, text.rowid)
    }

    if checkOnly {
        print("\(texts.filter(shouldSend).count) money text(s) would be sent from \(texts.count) message(s) read.")
        return 0
    }
    // Never save 0: with nothing read yet, the next run looks back a week again instead of reading all history.
    if last > (saved ?? 0) {
        try? String(last).write(to: stateURL, atomically: false, encoding: .utf8)
    }
    if sent > 0 { log("sent \(sent) text(s) to Alfred") }
    return 0
}

exit(run())
