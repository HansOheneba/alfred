# Alfred SMS relay for macOS

This relay reads the current macOS user's incoming Messages and sends approved provider SMS to
`https://alfred.hansopoku.com/api/ingest/sms`. Its service is
`com.hansopoku.alfred-relay`, separate from Money Tracker's collector.

Preparation, installation, configuration and activation are separate. Obtain
explicit approval before installing, creating an account forwarding key, writing
config, granting Full Disk Access, or enabling the service. Preparing code is not
permission to perform those actions.

## Prepare without activating

```sh
./install.sh --prepare
```

This compiles a local executable and stages an inactive LaunchAgent definition
and an invalid, empty config example in `relay/mac/build/`. A SHA256 interface
manifest binds both the binary and LaunchAgent definition and verifies expected
launch arguments before status/initialization calls. It does not install
anything, read Messages, accept a key, contact Alfred, or register/start a job.
The default command only shows help. Build output is disposable and must not be
committed or treated as a signed/notarized application.

Run `./test.sh` for synthetic SQLite, state, selection, retry and acknowledgment
fixtures, installer safety checks against fabricated files/mocked launchd, shell
syntax, and a production compile. It uses a separate test entry point and
never executes the normal relay or installer. An optional synthetic sandbox
probe is available with `ALFRED_TEST_SANDBOX=1 ./test.sh`; it uses fabricated
Messages/config files, never real messages or network traffic. A restricted
development run rejected `sandbox_init` with operation not permitted; the
fixture/build results therefore do not establish runtime sandbox compatibility.
Sandbox compatibility and Full Disk Access must be
checked on the target macOS version after approval. A successful build alone does
not establish that SQLite, the sandbox, or HTTPS work in the installed context.

## Explicit setup after approval

1. Run `./install.sh --install` to copy the staged executable and inactive
   LaunchAgent definition into the relay support folder. This leaves the service
   unloaded and preserves config/state. It does not put a definition in
   `~/Library/LaunchAgents`, where a later login could activate it. An existing
   loaded service or login definition blocks replacement and requires an explicit
   migration decision.
2. Create a forwarding key in the intended signed-in Alfred account's
   **Settings → Bank messages**, only after approval. This creates an account
   credential; **Reset key** invalidates the previous credential. Installation
   does not create or verify a key.
3. Choose the exact provider sender IDs you want relayed. Supported IDs are
   `absa`, `mobilemoney`, `hubtel`, `paysmall`, `t-cash`, `vf-cash`, `t cash`, and
   `stanchart`. These exact IDs were present in the reference collector and
   read-only sender/service metadata; no message bodies or collector credentials
   were inspected. GCB was not verified and is not included. Pass an explicit
   subset; there is no default selection. For
   example, `./install.sh --configure --sender mobilemoney --sender absa` prompts
   privately for the key. Input is hidden and never passed as a command argument
   or environment variable. Existing config is never overwritten. Do not paste
   keys into commands, screenshots, logs, documentation, or chat.
4. After approval, give the installed executable Full Disk Access in macOS
   System Settings. Its path is
   `~/Library/Application Support/AlfredRelay/alfred-relay`. iPhone Text Message
   Forwarding must already deliver SMS to Messages on this Mac. Neither setting
   is enabled by this script.
5. Run `./install.sh --enable` only when activation has been approved. If no
   state exists, `--initialize` reads the maximum ROWID across all Messages rows
   as a future-only baseline, without sending messages. The script then validates
   state, publishes the LaunchAgents definition, explicitly enables and loads the
   service. It may immediately send approved SMS that arrived after the baseline.
   SMS received before the baseline are excluded. An original-received-time
   fence also excludes old messages that synchronize to this Mac later. Existing
   state is preserved and validated. The future-only window starts at explicit
   baseline initialization, not at a later successful service start. If an
   activation attempt fails after initialization, that baseline is retained;
   a retry can send approved SMS queued since the earlier initialization.
   A legacy `last-rowid` blocks initialization/enabling until migration
   is explicitly resolved; it is never silently removed or converted.

The private `config.json` has this schema; this empty example cannot run:

```json
{
  "version": 1,
  "key": "",
  "senderAllowlist": []
}
```

Config must belong to the current user and have no group/other permissions.
The setup tool creates mode `0600` config inside a mode `0700` support directory.
The relay requires version 1, a nonempty supported sender subset and a valid key
format. Format validation does not establish key validity or account ownership.
There is no automatic credential generation or rotation.

## Selection and data sent

Only incoming **SMS** from the explicit supported sender subset are eligible;
iMessage, RCS, email senders and unsupported providers are excluded. The relay
requires at least one case-insensitive indicator: the word `GHS`, `GH₵`, `GH¢`,
the word `balance`, `purchase limit`, or `transfer of`. It excludes texts
containing the words `OTP`, `PIN`, `passcode` or `password`, verification/security/
authentication/authorization code, or one-time code. These are local selection
rules derived from the reference, not proof that every eligible text is a
transaction. The allowlist is stored in
state as well as config so changed selection requires an explicit decision,
rather than silently processing old messages under new rules.

Messages SQLite is opened read-only. SQL applies sender, incoming direction,
SMS service and activation-time filters before selecting or decoding bodies.
The sandbox grants database-file access, rather than a macOS permission limiting
access to particular rows. Requests contain up to
4,000 message-body characters, up to 80 sender characters, `source: "mac"`, and
the original received time. The key is used as bearer authentication.

The first run does **not** backfill history. Missing, invalid or incompatible
state fails closed; normal execution never creates a replacement baseline.
Decoding or delivery failures do not silently advance past the affected row.
State updates use a lock, a fixed adjacent temporary file, atomic replacement
and durability checks. A non-displayed SHA256 fingerprint binds state to the
configured credential; a key change invalidates previous acceptance metadata.
Potentially eligible rows with incomplete direction/sender/service/date metadata
hold the cursor until retry or explicit review. Known excluded senders and
non-SMS rows do not block forwarding. A fully populated excluded row is assumed
not to be rewritten later into an eligible provider SMS; arbitrary database
edits are not covered by cursor guarantees.

Retries are at least once: an accepted request followed by a lost acknowledgment
or failed local state write may be sent again. Alfred's duplicate response is
accepted, but the relay does not claim exactly-once financial processing.

## What Alfred does after receipt

Enabling this relay can change the Alfred account's financial records without
another prompt for every alert. The backend can store parsed bank-message
metadata plus up to 1,200 characters of raw SMS. Recognized fees can create
expense entries under **Fees** even while the main payment awaits a label.
Remembered payee/category rules can create expense or income entries; recognized
investment rules can add contributions or withdrawals to an existing investment.
Related messages may be linked to existing entries, and duplicates may be skipped.
Unfamiliar payments may remain under **Needs a label** instead of creating the
main entry immediately. This is financial ingestion, not merely a notification.

For unfamiliar eligible texts, the backend's configured DeepSeek reader may
receive the sender and up to 1,200 message characters to interpret the alert.
That model fallback can apply to Absa, PaySmall, T-Cash/VF-Cash and StanChart;
MobileMoney and Hubtel use the backend's known-sender rule path. Sender selection
therefore also controls which providers' unfamiliar text can reach the model.
The local fixed Alfred URL does not prevent this downstream model processing.

DeepSeek parsing requires the backend's model configuration. Telegram delivery
requires a configured backend bot and a linked, locked chat for the intended
account. Source presence or configuration booleans do not establish production
availability, a successful model request or actual delivery. Review the intended
deployment and account's destinations before activation; this relay's setup
does not link Telegram. When that connection exists, ingestion can send
financial summaries/questions to the account's locked chat and store the
notification in the website conversation.

## Inspect status without sending

```sh
./install.sh --status
```

This checks installed files, launchd registration and safe relay metadata.
It captures launchd output privately and exposes only its state, run count and
last exit code; raw output, which can contain environment values, is never shown.
It does not query Messages or make a network request. The service is an
intermittent worker triggered by Messages changes and a 120-second interval, so
a persistent PID is not required. A loaded job alone does not prove a successful
run, current Full Disk Access, account linkage, or delivery.

Status exits nonzero for incomplete registration, an absent or unverified build,
invalid config/state, unavailable service metadata, or a nonzero last service
exit code. Exit zero means complete setup metadata, not proof of current runtime
permissions or network health. The relay's `configurationReady` describes local
configuration, while `lastAcceptedAt`/`apiAcceptanceVerified` describe historical
successful API acknowledgements bound to the same configured credential. They
do not verify current Full Disk Access, network reachability, or a new delivery.

An installed binary or LaunchAgent without a matching safe-interface manifest is never executed
for status or initialization. Older relays ignored unknown flags, so probing
them with `--status` could start a normal send run. A missing/mismatched manifest
is reported as unavailable metadata instead of trying the executable.

The relay's safe `--check` reports counts only, with no sender, message body or
key. It reads Messages and requires separate authorization; it is not part of
`--prepare` or `--status`.

Acceptance metadata records successful Alfred responses locally; it does not
mean every accepted request created a new transaction, since Alfred can skip
duplicates or messages that do not represent a transaction. On the website,
**Connected** means the signed-in account has a forwarding-key record.
**Last message** is key-use metadata, not proof of successful ingestion or proof
that the request came from this Mac. Local key ownership is not established
merely by matching its expected syntax.

Use `./install.sh --disable` to explicitly disable future automatic starts and
unload the service. Config, state and definitions remain intact. No command
deletes config or resets the baseline. To update a previously activated setup,
resolve the existing login definition explicitly after disabling; the installer
will not silently overwrite it.

## Sandbox boundary

The sandbox is compiled into the executable and must initialize successfully.
It denies general file-content reads and writes, permits narrow system-runtime
resources, the Messages database/WAL/SHM, and the relay support directory. SQLite
may update `chat.db-shm` even with a read-only database connection. Writes are
limited to state/temporary state, lock, log and `/dev/null`; there are no broad
home-directory or temporary-directory write grants. Process forks and inbound
connections are denied.

The network rule permits outbound TCP on port 443, **to any hostname**. It does
not provide hostname confinement. Application code fixes Alfred's HTTPS URL and
rejects redirects; those checks are a separate boundary from Seatbelt. This
profile has not yet been verified for all required Apple runtime resources on
the target OS. Missing resources should cause a visible failure; do not broaden
permissions or claim successful delivery without testing after approval.
