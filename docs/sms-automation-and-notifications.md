# SMS automation and Alfred's notifications

This integration adds SMS automation and notification controls. Checking out,
building or testing it does not apply a database migration, create production
keys, start a collector, register a device, configure a scheduler or send a real
notification. Live use requires the separate setup and verification below.

## What is implemented

- A native Alfred Sync setup candidate in `relay/collector`, with build-time
  App Sandbox entitlements, exact provider scope, future-only initialization and
  a transactional per-message delivery outbox. It does not use the denied runtime
  sandbox initializer. Its build/package scripts never launch the app.
  The native window provides account confirmation, provider review, Messages
  permission guidance and explicit Start/Pause. A bundled 60-second agent runs
  only after saved, owner-bound consent; opening/installing alone never enables it.
- A read-only account identity check, explicit account-name/email confirmation,
  private key-bound owner metadata and fresh owner verification before live Mac
  access or delivery. Local status never claims it performed that fresh check.
- A protocol-2 event receipt bound to the confirmed owner, stable event ID and
  exact payload hash. Zero-result/legacy success responses cannot discard an
  alert. Unrecognized alerts stay privately held while later alerts can proceed.
- Streaming SMS request-size enforcement independent of `Content-Length`, strict
  UTF-8 decoding and bounded JSON traversal. Rejection logs exclude arbitrary
  headers, message contents, field names and credentials.
- Separate account choices for Money in chat, Money out chat, payment push,
  bill reminders and weekly overviews. All five default off. Chat choices save
  after a server acknowledgment. The explicit device-enable action requests
  browser permission, links this device and enables payment notifications only.
  Reminders, saved devices and Mac setup details are collapsed by default.
  Lost responses are shown as unconfirmed, with a read-only reload action.
- Deterministic Alfred messages in the authenticated conversation. A recognized
  incoming or outgoing alert is described as an alert, not independently verified settlement.
  Recognizing a provider alone never establishes purpose. Alfred acknowledges a
  meaningful saved classification on the owner's active principal record, and
  asks “What was this for?” when the alert still needs a label. Existing saved
  `Other`/`Misc` rules continue filing across all channels, even with automation
  off. A generic classification is not claimed to explain the purpose.
  An existing settled record with an unclear purpose directs correction through
  Review; a purpose reply cannot create a second income entry for it.
  Model-read or unknown alerts say “possible” and request review. Recognized
  transfers, loans, investments and card holds use neutral class-specific wording.
  Negative expenses reduce recorded spending without being guessed to be income
  or necessarily a refund. Skipped alerts generate no announcement. Existing
  incoming consent is preserved; outgoing announcements require their own opt-in
  and activation timestamp.
- An atomic message-plus-receipt write scoped to the owner and bank message.
  Duplicate ingestion and recovery cannot repeat that message, and clearing the
  conversation does not replay it. A classification change is rechecked before
  writing. Receipt state is operational data, not history to import or replay.
- Generated notices are excluded from later model-history input and require no
  additional model call. The existing user-requested finance context and optional
  unfamiliar-bank parsing remain separate features.
- Purpose replies are bound to the specific alert displayed in chat, including
  across retries and a newer arriving alert. A clear answer uses the existing
  labeling flow for that one alert; it does not learn a sender rule or label
  other waiting payments. Clear declarative hedges are accepted only when the
  category/details match the person's words; unresolved alternatives get a
  specific clarification. Thanks/ok get a natural no-change acknowledgment.
  Clear conventional gift-purpose language such as “birthday money from grandma”
  is sufficient evidence for Gift; a family relationship alone is not. Clear
  tenant rent and explicit repayment wording retain their financial meanings.
  A description such as “school fees from dad” still needs its financial type
  when the words do not establish gift, repayment, loan or own money.
  Stale or known alerts
  cannot fall through to another payment or an unrelated confirmation.
  The composer shows the payment reply context and offers “Start a new topic”
  for a separate request; that first turn carries no older payment or pending
  confirmation target. The explicit choice survives retries.
  After a closed notice, an explicit independent expense or budget request can
  start its own confirmation. Ordinary conversation can continue without
  leaving Alfred stuck on that payment. A later bare “yes” cannot revive an
  older pending action, and a purpose reply cannot duplicate incoming money.
  After a closed outgoing notice, one clearly separate expense or explicitly
  grounded income request can start its own confirmation. Captured principal,
  fee and fee-inclusive amounts remain protected; an unresolved external match
  or ambiguous amount/currency/date needs “Start a new topic”. The source's
  actual open-purpose state overrides stale client metadata. Multiple model
  actions cannot ride along with one grounded request. Conservative income
  wording such as “I got paid…” may still need that explicit topic boundary.
- Web Push subscriptions and delivery records remain server-only. Notification
  payloads contain fixed discreet copy and fixed authenticated destinations,
  without amounts, names, balances or raw SMS. An encrypted payment payload may
  include an opaque bank-message UUID locator for the fixed Accounts destination.
  The authenticated page resolves only its owner's exact source; a locator is
  never authorization. Separate payments have separate stable notification tags.
  The existing
  service worker imports the push handlers; there are no competing root workers
  and no financial response cache is added.
- An explicit test sends to one owned active browser, with a durable 30-second
  cooldown using the database's canonical device UUID. It never changes a
  financial record or account preference, and reports provider acceptance or
  uncertainty rather than claiming the notification was displayed.
- Newly ingested production batches commit bank evidence and financial effects
  in one owner-serialized database transaction. External parsing finishes first.
  A failed batch rolls back; a possibly committed transaction is never replayed
  internally. Historical partial records are not guessed at or rewritten.
- Owner/origin checks and displayed-account binding protect preference/device
  writes. Device endpoints cannot be reassigned between accounts. Devices are
  capped, and subscription expiry is respected.
- Idempotent per-event/device queues, rechecked preferences and activation epochs,
  bounded concurrency and deadlines, and independent recovery after bank commit.
  An ambiguous connection result or process interruption is not blindly resent.
  Provider acceptance is not proof that a notification appeared on the device.

## Reference behavior and deliberate differences

Money Dashboard's native app reads Messages, passes a private temporary record
file to Python, reconciles its archive and uploads a complete snapshot. It has
no runtime sandbox initializer. This integration does not modify that reference
collector's application, scripts, credentials, state or LaunchAgent.

The new Alfred collector is independent: activating it would add another
read-only Messages reader. A single shared reader would require a separately
reviewed change to Money Dashboard; its existing transient handoff/archive lacks
reliable SMS-service and activation provenance for an unchanged bridge.

The verified sender IDs are:

`absa`, `mobilemoney`, `hubtel`, `paysmall`, `t-cash`, `vf-cash`, `t cash`, `stanchart`.

Incoming SMS only, exact selected sender IDs, a provider-alert indicator and
strong credential-code exclusions are required. RCS, iMessage, personal senders,
GCB, generic MTN/Telecel and Achieve are excluded. This is the verified reference
scope, not an exhaustive payment-provider directory. Selection is code-level;
macOS file permissions do not restrict individual database rows.

Alfred requires an explicit current-row baseline plus original-date fence. It
never falls back to historical import if state is missing or corrupt. The first
Start excludes earlier message history. Pause stops subsequent automatic sends
without discarding saved alerts or advancing the scan position; an in-flight
request may still finish. Starting again catches up on eligible selected-provider
alerts received while paused and retries pending deliveries from the original
collection window. Alerts more than 24 hours old may update records or appear in
Review without a new private chat announcement; announcement opt-in times also
apply. Some alerts still need review rather than automatic recording. The
Messages file grants and SQLite WAL/SHM behavior on a target Mac remain unverified;
fixture tests and a valid code signature are not permission or runtime proof.
There is no automatic expansion to SHM write access.

The practical reference is an installed native Mac app plus automatic background
operation. Alfred Sync keeps that pattern with its own identity, state, account
confirmation and explicit consent. It announces both financial directions in
Alfred's private chat and retains the existing Review flow. Received provider SMS
include alerts about outgoing money: this does not require reading sent personal
messages. Neither a notice click nor a push changes a financial classification.

Bill reminders use the owner's timezone at 09:00 the day before an active,
confirmed bill. Imported inactive bills stay inactive. Weekly notices use Sunday
18:00 in the owner's timezone and are conservatively suppressed without an
accepted automatic provider alert in the last 48 hours. This freshness heuristic
is not a collector health or heartbeat check; a quiet but current account may
not receive a weekly notification. If the account already has a linked Telegram
chat and the backend bot is configured, existing payment summaries/questions
can send payment details there independently of the new chat and push choices.
This work does not link Telegram or verify production destination settings.

## Fictional previews and checks

The demo page `/preview/sms-automation` renders fictional known-purpose,
unknown-purpose and uncertain alerts using the actual message builder. Its
fictional reply interaction shows a clear answer and a vague clarification.
Its controls cannot request
permission, register a browser, write settings or send notifications.

```sh
ALFRED_LOCAL_PREVIEW=1 npm run dev -- --hostname 127.0.0.1 --port 3117
```

The three demo pages are available with the local flag in development/test and
in Vercel preview deployments. They stay unavailable in the main production
environment. Only GET/HEAD requests to these exact demo paths bypass the auth
proxy; they do not read an account, refresh a session or contact configured
services. Real app routes retain their normal authentication and data behavior.
The placement preview
is `/preview/automations#automations`, using the shared Settings navigation and
real Automations components with fictional, inactive preferences. Other section
buttons show read-only placeholders in this fictional preview. All five demo
notification choices can be toggled and saved for the current visit, with a
reset control. Reload starts with all five off; no real preferences are saved.
The sample device-enable and test interactions are labelled simulations and do
not request permission, register a device, write preferences or send a push.
The three-step fictional setup is `/preview/automations/mac-setup`: it exercises
an account mismatch, permission explanation, provider selection and future-only
review. Completion explicitly leaves capture off; it makes no account or OS call.

Actual SMS capture and notification choices are under **Settings → Automations**,
after Reminders. Existing **Bank messages** tools stay in place, including keys,
manual forwarding and review. Old `#notifications` links open Automations.

Unreadable/incomplete source rows retain private references while later alerts
continue. Cursor, references and good outbox messages commit together; repaired
rows retry behind the cursor
under the original activation fences. Safe counts are exposed in Mac check-ins.

Old or unverifiable browser push keys require an explicit reconnect, preserving
the existing subscription. With payment choices off, bank automation performs
one preference read and no notice/push/queue work. The SMS route retains its
60-second maximum. Chat and push start independently after persistence, with
up to 25 seconds of delivery time capped at 55 seconds from request start.
Slow chat work cannot consume the push transport's completion budget. A later
scheduled check recovers unfinished queue work without another SMS.

Operator configuration and read-only readiness checks are documented separately
in [automations-operations.md](automations-operations.md). Consumer Settings
shows concise availability rather than keys, scheduler instructions or schema
diagnostics. The readiness checker does not provision or verify live services.

Payment nudges have no overnight hold: opted-in eligible alerts can dispatch
immediately, including overnight. Transport retries and recovery remain durable;
this is not a promise of instant display by a browser or operating system.
Every positive eligible amount, including 0.50, is announced without an
amount-based settling delay. Bare debits remain visible for review and do not
wait for another alert. Confirmed fee-only evidence suppresses a separate
principal notice. A fee SMS arriving first can initially produce a purpose
question; later fee linking can leave that question outdated. The source is
rechecked before another label is applied. That accepted trade-off avoids delaying
legitimate payments. No small-payment skip is reinstated and existing financial
records are not rewritten.
Bill and weekly schedules, account/device activation cutoffs and opt-outs remain
unchanged. New push opt-ins fail closed without configured recovery and a recent
completed authenticated dispatcher check-in. Scheduler registration and
production health are not established by this implementation.
The draft policy cleanup releases only never-attempted legacy payment holds.
Already-attempted legacy rows need metadata review because the earlier schema
did not distinguish an overnight hold from retry backoff; retries must not be
shortened blindly.

```sh
npx --no-install next typegen
npm run typecheck
npm test
npm run build
# Supported alternative when the environment prevents Turbopack's local worker port:
NEXT_TELEMETRY_DISABLED=1 npm run build -- --webpack
relay/collector/scripts/test.sh
relay/collector/scripts/build.sh
```

Collector tests use a separate entry point, fabricated Messages databases and
injected transport; they never launch the staged app or open real Messages.
The older guarded `relay/mac` implementation is retained as a disabled legacy
path. Do not retry its denied initializer through another launcher. Its source
now has safe defaults rather than the former automatic seven-day backfill.

## Held alerts: private Mac review

These three cases need different handling:

| Case | What is retained | Current user action |
| --- | --- | --- |
| Source quarantine | Private source references and reason counts; no copied unreadable/unknown-routing body | Automatic repair retries; safe counts in Automations |
| Decoded alert held locally | Original private outbox payload after Alfred could not issue a durable processing receipt | Mac review: Try again, Not a payment, Later |
| Alfred payment needing a label | An owned, durably stored bank-message record | Existing authenticated Review and purpose replies |

A locally held decoded alert has already been submitted to Alfred and may have
reached its unfamiliar-alert parser. “Held on your Mac” means processing was not
durably acknowledged; it does not mean the text was never transmitted. Health
reports never upload those bodies to make a review list. One SMS can describe
several movements: some may already have been stored or recorded while another
was intentionally ignored or could not get a durable receipt. A held whole SMS
therefore must not be described as “nothing recorded.”

The Mac app now has an explicit **Review saved alerts** entry from its inactive
opening notice and a `--review-held` command. It shows one decoded held alert
locally, with **Try again**, **Not a payment** and **Later**. Review reads only
the collector's private configuration, saved account confirmation and outbox;
it does not read Messages, check the account online, deliver an alert, report
health or start a service. Its window explicitly labels the connection as a
saved confirmation, not a fresh online check. Missing setup shows a plain
explanation instead of initializing state.

Every decision rechecks the saved owner/key/provider scope and exact event,
payload, hold and attempt version under the collector lock and a database
transaction. A private, content-free audit makes retries idempotent. The ledger
is added transactionally on an explicit decision; no baseline reset or capture
schema migration is performed. Retry preserves the original event and payload
and only makes it eligible for a future, separately authorized delivery run.
That run still performs its existing fresh authenticated account check. Not a
payment defaults to keeping the alert in a confirmation dialog; a confirmed
choice removes the local pending body while keeping deduplication metadata and
any existing server records. Later keeps the payload. Bounded pagination keeps
alerts beyond the first hundred reachable; Refresh includes deferred items.

The warning explains that some movements may already be in Alfred. No action
records a payment or claims server acknowledgement. Manual financial recording
would additionally need durable per-movement
links/dispositions, an owner/event-bound idempotent server path and explicit
confirmation. It must resolve only unresolved parts, never “record the whole
alert” again, and cannot blindly reuse Review when the matching record is absent.
No manual financial resolution or new server mutation is added by Mac review.
Native window compilation and synthetic state tests are separate from a real
Mac runtime/UI verification. The user approved opening the setup window and
confirmed it in a screenshot. Installation, held-alert interactions, permission
grants, service registration and actual delivery remain unverified.

## Activation remains a separate operation

Collector account checks and health posts are throttled before identity lookup.
They share a 1,200-request/minute overall budget, 120/minute advisory client
bucket and 60/minute key bucket. Fixed hash slots bound counter growth when
callers rotate headers or invalid keys; collisions can reject earlier. Headers
never establish identity. Rejection logs contain only the endpoint and fixed
reason, never keys, names, email addresses, IP addresses or message text.
Account identity reads remain SELECT-only, while throttling writes operational
counters. Missing throttle storage fails closed.

Owners can remove a saved Mac status from Automations after confirmation. This
frees a slot at the five-Mac status limit. It removes only that owner's selected
status entry: it does not revoke a forwarding key, stop a collector, remove local
alerts or change financial records. A still-active Mac can check in again.

Before live use, review and approve each applicable step:

1. Review the target database's applied history, then apply only reviewed pending migrations
   through the normal database workflow: notifications, bank-notice receipts,
   collector receipts, notification recovery, collector health,
   immediate-payment policy cleanup, owner-controlled removal of saved Mac
   status, both-direction activity announcements and fee-notice readiness. The general runner applies all pending
   migration files, not a hard-coded pair. None has been applied to a real
   database here.
2. Resolve and verify the new Mac app's static sandbox and Messages DB/WAL/SHM
   access on the target OS. Explicit Full Disk Access is separate from App Sandbox.
   The staged app and disabled LaunchAgent template are not an installation.
3. Create/store the intended account forwarding key through the approved private
   input flow; choose the explicit provider subset; initialize future-only state.
   Existing installed relay credentials/state have not been created or changed.
4. Install/enable the reviewed collector and its automatic schedule only after
   that runtime verification and action-time approval. No setup page starts it.
5. Supply Alfred's own VAPID public/private keys and subject using the normal
   secret-management flow. No reference credentials or contact values are copied.
   Push requires `ALFRED_PUSH_DELIVERY_ENABLED=true` plus explicit per-account and
   per-browser opt-in. Merely configuring keys cannot enable a preference.
6. Before enabling any device push, including payment nudges, configure an
   authenticated caller for `POST /api/notifications/dispatch`, with `ALFRED_NOTIFICATION_CRON_SECRET`
   and `ALFRED_NOTIFICATION_SCHEDULES_ENABLED=true`. Record the actual schedule
   identifier in `ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID` and its interval in
   `ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS` (60–300 seconds). A completed
   authenticated dispatcher check-in must be recent before push can be enabled;
   metadata alone does not prove that a schedule exists. Delivery has its own
   master gate. See `lib/notifications/README.md` for the recovery contract.
   No cron or automation has been registered by this work.
7. Verify actual acceptance only from naturally arriving authorized alerts. Do
   not fabricate SMS, run test ingestion or send a test push without authorization.

Forwarding sends selected text/sender/time to the fixed Alfred ingestion URL.
Alfred stores recognized alerts and may update fees, income/expenses and other
financial records under its existing rules. Unfamiliar eligible alerts may use
configured Claude (Anthropic) parsing. Pending local outbox bodies are private and removed
from the active outbox after acknowledgment; this is not a claim of forensic
removal from filesystem snapshots or backups.
