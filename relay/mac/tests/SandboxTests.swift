// Applies the compiled profile only to fabricated Messages/config/state files.
// No normal relay entry point, real Messages access or network task is executed.
import Foundation
import SQLite3
import Darwin
@main struct SandboxTests {
    static func main() {
        guard CommandLine.arguments.count == 2 else { exit(2) }
        let home = URL(fileURLWithPath:CommandLine.arguments[1]).resolvingSymlinksInPath()
        let relay = home.appendingPathComponent("Library/Application Support/AlfredRelay")
        let messages = home.appendingPathComponent("Library/Messages")
        var stage = "fixture preparation"
        do {
            try FileManager.default.createDirectory(at:relay,withIntermediateDirectories:true,attributes:[.posixPermissions:0o700])
            try FileManager.default.createDirectory(at:messages,withIntermediateDirectories:true)
            let fixtureConfig = Config(version:1,key:"alf_" + String(repeating:"z",count:24),senderAllowlist:["mobilemoney"])
            let configPath = relay.appendingPathComponent("config.json")
            try JSONEncoder().encode(fixtureConfig).write(to:configPath)
            try FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:configPath.path)
            let denied = home.appendingPathComponent("personal-fixture.txt")
            try Data("synthetic private fixture".utf8).write(to:denied)
            let database = messages.appendingPathComponent("chat.db")
            var db:OpaquePointer?
            guard sqlite3_open(database.path,&db)==SQLITE_OK else { exit(1) }
            guard sqlite3_exec(db,"create table message (ROWID integer primary key); insert into message values (1);",nil,nil,nil)==SQLITE_OK else { exit(1) }
            sqlite3_close(db)
            stage = "sandbox initialization"
            var error:UnsafeMutablePointer<CChar>?
            let result = home.path.withCString { value in "HOME".withCString { key in
                let parameters:[UnsafePointer<CChar>?] = [key,value,nil]
                return sandbox_init_with_parameters(sandboxProfile,0,parameters,&error)
            }}
            if result != 0 {
                print("SKIP: environment could not apply the synthetic sandbox; runtime compatibility remains unverified.")
                exit(77)
            }
            stage = "private config read"
            let checked = try loadConfig(at:relay)
            stage = "read-only synthetic database"
            let reader = try MessagesDatabase(path:database.path)
            guard try reader.maximumRowID()==1 else { exit(1) }
            stage = "atomic state and lock"
            let store = StateStore(relay)
            try store.withLock {
                let baseline = State(version:1,lastRowID:1,initializedAt:timestamp(),senderAllowlist:checked.senders,
                                     credentialFingerprint:checked.credentialFingerprint,acceptedCount:0,lastAcceptedAt:nil)
                try store.save(baseline)
                _ = try store.load(config:checked)
            }
            stage = "denied personal read"
            if (try? Data(contentsOf:denied)) != nil { throw RelayFailure("unexpected read") }
            stage = "denied configuration write"
            if (try? Data("not a credential".utf8).write(to:configPath)) != nil { throw RelayFailure("unexpected write") }
            stage = "denied arbitrary write"
            if (try? Data().write(to:home.appendingPathComponent("unapproved-output"))) != nil { throw RelayFailure("unexpected write") }
            print("PASS: synthetic sandbox permits DB/config reads and atomic state, denies personal reads and config/arbitrary writes; no network attempted.")
        } catch {
            fputs("FAIL: sandbox synthetic stage: \(stage)\n",stderr)
            exit(1)
        }
    }
}
