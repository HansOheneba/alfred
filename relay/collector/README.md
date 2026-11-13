# Alfred Sync — local Mac setup candidate

This directory is a new native macOS collector candidate for Alfred. It does
not modify an existing **My Money Sync** app, its Python scripts, credentials,
archives, cursor or LaunchAgent. It does not replace or launch the earlier
`relay/mac` executable.

**Build and fixture results are preparation evidence only.** The app is not
installed, configured, granted Full Disk Access, registered for login, or
activated by this work. No real Messages or credentials are used in fixtures.

## Build and pure fixtures

From this directory:

```sh
./scripts/build.sh
./scripts/test.sh
```

`build.sh` compiles in a temporary directory, applies an ad-hoc local-development
signature, verifies its declared entitlements, and stages
`build/Alfred Sync.app.zip` plus a build manifest. It verifies the signature
again after an archive round trip, without executing the app. A ZIP avoids
FileProvider-added Finder metadata interfering with signing of `.app` folders;
no quarantine/security attributes are stripped.
It does **not** launch, install, configure or register the app.
The ignored build folder contains no real credentials.

The current local candidate targets **Apple Silicon and macOS 27 or later**.
Its minimum-version declaration matches the inspected Mach-O requirement; it
does not establish successful Messages access on that OS. Intel Macs and older
macOS releases are unsupported by this prototype. Source compilation alone
would not establish their compatibility. A distributable release still needs a
stable Developer ID signature, notarization and runtime verification. A copy-only
installer and guarded release-candidate workflow are prepared in
[PACKAGING.md](PACKAGING.md), without installing or activating the collector.
The current ad-hoc signature is for local
preparation only. The build manifest reports the inspected architecture and
minimum OS; it must not be treated as a runtime or notarization result.

`test.sh` compiles a separate synthetic test entry point. It exercises core
selection, source queries against fabricated SQLite databases, outbox
transactions and an injected transport. `AppMain.swift` is excluded, so the app
entry point, real Messages path, private key prompt and HTTP delivery are not
executed. A successful fixture run is not a runtime platform-access result.

The prepared installer only copies the app; no installation or background
registration has been run. Opening the app shows its setup window and reads safe
saved status only. Connect privately accepts an existing key and displays the
resolved name/email for explicit confirmation; provider choices remain explicit.
Check Messages reads headers only after a fresh owner/server-readiness check.
Start repeats those checks, establishes a future-only baseline if safely new,
and requests the bundled one-minute service after confirmation. Requiring macOS
approval is shown as pending, never as running. No key, permission or service is
created merely by opening the app.

Pause revokes saved consent independently of the collector's work lock before
unregistering its own service. It works without network/FDA and retains the
outbox/baseline. Scheduled runs recheck consent before capture, each send and
health reporting. An already initiated request may finish; Pause cannot recall
an accepted alert. Starting again catches up on eligible selected-provider alerts
received while paused and retries saved alerts; it does not start a new collection
window. Messages from before the first Start remain excluded. Alerts more than
24 hours old may update records or appear in Review without a new private chat
announcement. A caught-up alert can still require review rather than create a
financial entry automatically. Review saved alerts remains private/local-only. The native
setup window opened in a user-approved local review. Real Messages permissions
and service operation remain unverified at runtime.

## Architecture and the Money Dashboard comparison

Money Dashboard's native app reads selected Messages rows, writes a private
temporary handoff file, and invokes its Python reconciliation/upload script.
This candidate reuses that general native-reader pattern and the safer Alfred
filtering rules, with a separate durable Alfred outbox. Python is not required
to reproduce the behavior.

Preserving the installed collector unchanged means this candidate is a **second
read-only Messages reader**. The current Money Dashboard archive is historical,
and its temporary handoff does not provide a reliable, incremental SMS-only feed.
Neither is used as an Alfred input. A future single-reader bridge would require
an explicitly approved change to Money Dashboard that exports an eligible,
deduplicated event stream with service and activation metadata.

Collection and delivery have independent progress. Capturing an eligible event
and advancing the local capture cursor happen in one SQLite transaction. A
network failure leaves the event pending without requiring another collection
of its body. Message GUID deduplication prevents the same source event being
queued repeatedly. Money Dashboard's upload/readback state does not gate
Alfred's outbox.

## Proposed platform boundary

The app uses a build-time App Sandbox configuration and the stable bundle
identifier `com.hansopoku.alfred.collector`. It does **not** call
`sandbox_init`, `sandbox_init_with_parameters`, or another runtime replacement
for an inherited sandbox. It must not be used as an alternate launcher to work
around a denial from the legacy relay's runtime sandbox initializer.

The declared Messages file scope is read-only access to exactly `chat.db`,
`chat.db-wal`, and `chat.db-shm` under the current user's `Library/Messages`
directory. There is **no SHM write entitlement**. The database connection is
read-only. If SQLite requires SHM writes for this database on the target OS,
that is a platform-access blocker; this prototype must not add a write grant or
broaden its scope automatically.

Explicit live commands first use public code-signing inspection to require the
expected App Sandbox declarations, exact proposed file scope and bundle ID.
Missing or changed declarations fail closed before configuration, Messages
access or delivery. This check confirms declared scope, not that the OS has
granted access or that the target database can be opened.

App Sandbox access and **Full Disk Access are separate controls**. FDA covers
protected Messages data, but does not override an App Sandbox denial. Likewise,
a sandbox entitlement or user-selected file grant does not replace FDA. Signing
the old executable or opening it in Terminal is not a documented fix for the
earlier runtime sandbox error.

Apple documents App Sandbox apps/helpers and file-access mechanisms, but does
not guarantee this exact Messages database/WAL/SHM reader or its schema on
macOS 27. The proposed access combination is **unvalidated**. A successful
compile, ad-hoc signature, or entitlement inspection does not establish runtime
permission, App Store acceptance, or successful collection.

The App Sandbox outbound-client entitlement permits more than port 443. The
application fixes the destination to
`https://alfred.hansopoku.com/api/ingest/sms`, rejects redirects, and uses normal
HTTPS certificate validation. Those code checks are not OS hostname or port
confinement. This security-boundary difference must be reviewed explicitly
before any real app execution or activation.

References:

- [Apple: configuring the macOS App Sandbox](https://developer.apple.com/documentation/xcode/configuring-the-macos-app-sandbox)
- [Apple: embedding a helper tool in a sandboxed app](https://developer.apple.com/documentation/xcode/embedding-a-helper-tool-in-a-sandboxed-app)
- [Apple DTS: independent sandbox and file-access controls](https://developer.apple.com/forums/thread/678819)
- [Apple: temporary file-access entitlements](https://developer.apple.com/library/archive/documentation/Miscellaneous/Reference/EntitlementKeyReference/Chapters/AppSandboxTemporaryExceptionEntitlements.html)
- [Apple Support: Full Disk Access includes Messages data](https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac)

## Message scope

The eight supported exact sender labels are:

```text
absa
mobilemoney
hubtel
paysmall
t-cash
vf-cash
t cash
stanchart
```

They were established from the existing collector and read-only sender/service
metadata. Matching is case-insensitive and exact after trimming. It is a sender
label rule, not cryptographic proof of provider identity.

Only explicit incoming **SMS** from the approved sender scope qualify. Personal
senders, iMessage, RCS and outgoing messages are excluded. Generic `MTN`,
`Telecel`, `Achieve` and `GCB` remain excluded; their payment-only scope was not
established by the reference lookup.

The local alert filter requires a money/balance/transfer indicator and blocks
credential-like wording conservatively, including generic code/token wording,
OTP, PIN, passcode, password and common verification/authentication phrases.
Screening normalizes Unicode and separators without changing the stored body.
Legitimate alerts mentioning a reference code may be excluded. This English-marker
filter is not a guarantee of recognizing every language or possible secret.
Provider scope and content filters are applied before queuing delivery.
Incomplete routing metadata and undecodable eligible bodies become durable,
content-free source quarantine references. The cursor can progress only in the
same transaction that saves those references and any later eligible alerts.
No missing sender is guessed to be either a provider or a person.

An explicit future-only baseline permanently records the initial source high-water
mark separately from the advancing scan cursor, plus activation time. Both are
enforced for new captures and repaired source rows: older source rows and old messages that sync
to the Mac later remain excluded. Missing, corrupt or incompatible state does
not create a replacement baseline or trigger a historical scan.
The window starts at explicit initialization. If a later step fails, the same
baseline remains; a future approved retry may process eligible alerts queued
since that original initialization rather than silently resetting the window.
Pause likewise retains that original window and scan position: a later explicit
Start catches up on eligible alerts received during the pause, not only alerts
received after resuming. Pending deliveries are retained for retry. This is catch-up
within the original collection window, not an import of pre-Start message history.
Private chat announcements require payment and detection times within the past
24 hours and after the relevant announcement opt-in; a later catch-up can update
records or Review without a new announcement. Protocol-2 delivery rejects original
received times more than 45 days old; those alerts are not silently accepted.

## Outbox, acknowledgements and sensitive data

The private outbox stores the minimum pending payload: stable source identifier,
sender, original received time and message text. Capture and cursor advancement
are atomic. Acknowledged events retain safe receipt/deduplication metadata while
their raw delivery payload is removed. The outbox uses `secure_delete=ON`, a
`DELETE` journal and full synchronous commits. Those controls do not promise
forensic erasure from filesystem snapshots, backups or unreclaimed storage.

The app resolves its own container's `Application Support/AlfredCollector`
directory. Its parent is private mode `0700`; `config.json` and `outbox.sqlite`
are private mode `0600` files owned by the current user. These are separate from
both My Money Sync's support folder and the earlier `AlfredRelay` installation.

The payload contains up to 4,000 text characters, up to 80 sender characters,
`source: "mac"`, and the original received time. A forwarding key authenticates
the intended Alfred account. The key is never included in status, logs, command
arguments, fixture reports or source control. No actual key is created or stored
by local preparation.

Only a protocol-2 receipt matching the event, exact payload hash and confirmed
account permits deletion of a pending payload. The backend commits the receipt
only after it can identify owned durable bank-message rows for every parsed
movement. Legacy count-only responses, including a zero-result success, never
authorize deletion. Receipts contain hashes and record IDs, not raw SMS or keys.
Unrecognized alerts stay in the private outbox for review and do not block later
alerts. Network failures, malformed receipts and failed persistence retain the
payload. A lost response can be retried against the same durable receipt without
repeating ingestion; a receipt still does not prove settlement or a new financial
record. The explicit **Review saved alerts** window now shows decoded held
alerts privately on this Mac. It is available from the setup window
or `--review-held`. It never reads Messages, contacts Alfred or starts
collection. The saved account confirmation is clearly labelled as not freshly
checked online. Actions recheck that local connection and the exact saved alert:
**Try again** makes the original event eligible for a later authorized delivery;
**Not a payment** requires confirmation, removes only the local pending copy and
keeps duplicate protection; **Later** keeps it saved. None changes existing
financial records or claims an Alfred acknowledgement. Source quarantine stays
metadata-only and uses the existing repair retries. Decisions have a private,
content-free audit and are atomic/idempotent; a stale window cannot act on a
changed alert or the next item. The held-alert window is compiled and
state-tested with fixtures; its runtime interactions remain unverified.
Protocol 2 ingests only its exact top-level text/sender/time fields; legacy
Shortcut aliases cannot substitute another payload. The confirmed owner is also
asserted before ingestion, so a mismatched recipient is rejected before a claim
or financial operation rather than only being noticed in the response.

Before any live Messages access or delivery, the app checks its existing key
against the fixed `/api/collector/account` endpoint. Its identity lookup is
read-only; request throttling writes operational abuse-limit counters. It does
not create keys, record alerts or update a delivery timestamp. Setup displays the
account name and email and requires explicit confirmation. A separate private
`account.json` binds that owner to the key hash. Missing, changed or unverifiable
bindings stop live commands. The endpoint creates no key and does not update a
delivery timestamp. Local status reports saved confirmation separately from a
fresh server check.

Status and logs must distinguish:

- code built or staged;
- local configuration/state valid;
- Messages access successfully established;
- a real collection run completed;
- Alfred acknowledged a request;
- the backend actually filed a new financial item.

These are separate facts. A local cursor or an HTTP acceptance receipt alone is
not proof that a new transaction was created.

## Explicit command interface — future approved setup only

These commands are implemented for a later reviewed runtime plan. They are not
run by the build or fixtures, and must not be used to route around a runtime
permission or sandbox denial.

| Argument | Effect |
| --- | --- |
| none | Show the native setup/status window; account connection, Messages check, Start/Pause and local review require explicit actions |
| `--status` | Read safe configuration/outbox metadata only; no Messages query, network request or reset |
| `--review-held` | Open private local held-alert review; saved account confirmation only, no Messages, network, delivery or service operation |
| `--configure --sender ID [--sender ID ...]` | Validate senders, privately accept an existing key, check the account without SMS, show its name/email and require `CONNECT`; save private config/binding exclusively; no baseline or service enablement |
| `--verify-account` | Explicitly confirm an existing configuration through the same account check; cannot switch owner or reset baseline/queued alerts |
| `--initialize` | Recheck the confirmed account, then establish a new explicit future-only high-water mark/date fence; no SMS body read, delivery or service enablement |
| `--collect` | Capture eligible events into the outbox, then attempt a counts-only health check-in; no SMS delivery |
| `--deliver` | Deliver existing pending events only; no Messages read |
| `--run` | Perform one collection/delivery cycle, then attempt a counts-only health check-in; no background registration |
| `--scheduled-run` | Bundled service entry only: fresh account/server readiness plus saved matching activation required; recheck consent before capture/send/report |

Unknown arguments fail without an operation. Existing baseline, sender scope or
credential changes require an explicit migration decision; no command silently
resets state. No command creates a forwarding key on the website, grants FDA,
installs the app or enables login startup merely by being launched. Explicit
Start in the native window requests the bundled service through SMAppService.
All live collection/delivery commands perform the account recheck first. Their
new receipt contract requires the corresponding backend code and receipt migration
to be deployed through an approved workflow. Existing outbox version-1 state is
rejected for explicit review; it is never silently migrated, cleared or rebased.

The user-facing setup preview keeps the explanation to account confirmation,
Messages access and selected future alerts. It is fictional and does not replace
an installer or a real Mac permission check. Unreadable selected rows and unknown
routing headers are retained by ROWID and optional hashed GUID, without copying
their bodies, while later alerts continue. Each cycle scans at most 500 raw
headers and separately retries up to 100 older quarantined references, rotating
by last attempt so one unresolved row cannot starve the rest. A repaired row is
re-evaluated against the original ROWID/date fences, exact sender/service scope
and credential filter before it can enter the outbox. A deleted or changed
source identity stays visibly unresolved rather than being silently discarded.

Local `--status` includes counts, a first quarantined ROWID and aggregate retry
metadata. The JSON payload of remote health check-ins contains only an opaque
per-Mac UUID, counts, an enum state and separate capture/acceptance timestamps:
no ROWID, source GUID, hash, sender, message body, key or free-text error. The
health request authenticates with the existing forwarding key solely in its
HTTPS `Authorization` header to the fixed
`https://alfred.hansopoku.com/api/collector/health` endpoint. The server checks the
confirmed account owner before saving status; the key is never placed in URLs
or logs. These check-ins distinguish source rows awaiting repair from decoded
alerts held for review after a server response.
`health-device.json` is created privately only during explicitly confirmed setup;
it is an operational identifier, not an authentication credential. A bounded
health request runs after collection/delivery, and its failure cannot roll back
capture or prevent delivery. The authenticated Automations page shows check-ins,
pending work and review counts; an old report never proves current operation.
Quarantine metadata has no automatic expiry
or cap that drops references; a very large unresolved backlog can therefore grow
the private local database and needs an explicit review decision. No raw payload
is copied for unreadable or unknown-routing rows. The fresh prototype uses
outbox schema 3; older schemas fail closed without automatic migration/reset.

## What happens after receipt

Alfred can store parsed information and up to 1,200 raw-text characters. Existing
rules may automatically record fees, income/expenses or investment activity;
unfamiliar payments may await a label. This is financial ingestion, not only a
notification.

The backend may send the sender and up to 1,200 characters of unfamiliar eligible
alerts to Anthropic's Claude. The inspected known-sender rule bypasses that model fallback
for MobileMoney and Hubtel; it may apply to unfamiliar alerts from the other
approved labels. Before live setup, each user must review and approve the
selected-provider forwarding and possible Claude parsing for their own
account. Approval from another account or a development session is not consent
for a new user.

Telegram and browser-push delivery are backend/device capabilities, not Messages
permissions granted to this collector. Linking a destination, creating push
credentials, subscribing a browser or enabling a service is not performed by a
collector build. Production provider availability and an account's linked
destinations must not be inferred from source presence.

## Preparation and later setup boundaries

Local preparation may build an inactive bundle and run pure synthetic fixtures.
It must not execute the app, open real Messages, make an ingestion request,
create/store a forwarding key, grant FDA, install files outside the worktree, or
register/start a login item or LaunchAgent.

Before a later activation plan:

1. Establish a documented permitted runtime path and validate the proposed
   App Sandbox/file-access combination on the target OS without weakening it.
2. Review the changed OS sandbox boundary and independent-reader architecture.
   A shared-reader approach instead needs approval to modify Money Dashboard.
3. Bind the app to the intended Alfred account through a privately entered key;
   preserve any existing credentials and state unless a separate migration was
   approved.
4. Have the user grant only the reviewed macOS permissions to this app identity.
5. Establish the explicit future-only baseline before collection. No historical
   import is implicit. Background registration is an explicit Start action,
   separate from installation and permission review.
6. Verify any later registration and runtime health separately. Claim delivery only from
   safe evidence for a naturally arriving approved alert, never a fabricated SMS
   or test ingestion.

No step above is performed merely by checking out, compiling or testing this
directory. Unsupported platform access remains a blocker, not a reason to
remove sandbox checks or widen permissions silently.

## Explicit automatic operation

The app bundles `com.hansopoku.alfred.collector.agent.plist` in
`Contents/Library/LaunchAgents`. Its fixed BundleProgram points to this app's
stable executable with `--scheduled-run`, RunAtLoad and a 60-second interval.
SMAppService manages registration only after explicit Start; the installer
contains no registration script or external log paths. A pending macOS approval
stays visibly inactive until approval and a fresh explicit Start. The older
`LaunchAgent.plist.template` is retained as an inactive source reference only.
Neither build nor packaging copies a job into `~/Library/LaunchAgents`.

`--run` attempts existing outbox delivery even if a new capture is held. Capture
and delivery state remain separate: incomplete source metadata is durably
quarantined with cursor progress, and a network failure does not discard pending payloads.
Each delivery batch is limited to three requests and a 90-second elapsed budget;
another request starts only with at least its full 40-second request window
remaining. Unclaimed rows stay pending without changing the capture cursor or
attempt count. The work lock prevents an overlapping scheduled tick from
capturing or delivering the same outbox; actual cadence is best effort while the
Mac is awake. Private activation is rechecked before each send and capture, and
Pause revokes it independently of that work lock.

Before the bundled agent can become an active service, a separate approved step must
validate the signed app's actual Messages/FDA access and background launch
context on the target OS and explicitly authorize registration/autostart. Do not
use a different launcher to route around the earlier runtime sandbox denial.
No platform access, service registration or actual delivery has been performed
by this local build/test work.
