# Money-style Alfred Sync: local review

Prepared 3 November 2026 from merged main `bb0f978` on
`fix/money-style-sms-setup-20261103`. This report records the local verification
checkpoints; publication is tracked in [PR #27](https://github.com/HansOheneba/alfred/pull/27).

## Result

The existing Money sync app was inspected read-only. It runs every minute while
the Mac is awake and selects received provider SMS; those messages include both
money coming in and money going out. Its installed app, background job, private
configuration and data were not changed or reused.

Alfred now has its own native **Alfred Sync** setup window, rather than an
instruction-only prototype. It connects an existing forwarding key, asks the
user to confirm the resolved account and providers, checks Messages access,
and offers explicit Start, Pause and saved-alert review controls. Opening or
installing the app does not start capture. Start establishes a future-only
baseline for a safely new setup and requests a bundled one-minute service.
Pending macOS approval remains inactive. Pause preserves saved alerts and the
original collection window; it blocks subsequent sends independently of the
worker lock. An already initiated request may finish.

Alfred's chat can announce both money-in and money-out alerts. These are separate
off-by-default choices; existing incoming consent remains intact. Normal
payments, transfers, loans, contributions and investments retain their own
accounting meaning. Fees are preserved. A purpose reply to an outgoing notice
labels the captured payment without adding another expense. Stable receipts
and atomic source/owner/consent checks prevent duplicate notices and stale
source updates. Device notifications remain a separate choice.

## Verification

- Final local review follow-up: 1,497 application tests across 128 files passed.
  The published `52fd5fb` checkpoint had 1,433 tests across 127 files; it does not
  include the subsequent local review corrections described below.
- Typecheck, Webpack production build and whitespace checks passed. Lint had zero
  errors and three existing unused-variable warnings.
- Portability SQL: 381 synthetic assertions passed across the existing integration
  suites; archive: nine tests passed.
- Eight-file automation migration rehearsal: 40 in-memory assertions passed.
  Catalog-only readiness also tested old-schema refusal, new-schema acceptance,
  missing-function refusal and no financial/preference creation.
- Native: 497 synthetic assertions, ten policy tests and 13 packaging tests
  passed. Optimized compilation, declared entitlements, ad-hoc signing, archive
  round trip, copy-only installer contents and bundled service scope passed.
- The initial desktop and 390-pixel mobile previews showed both announcement directions,
  independent switches, safe outgoing purpose replies and no horizontal overflow.
  Preview console error log was empty. Preview choices were reset afterward.

## Local candidates

Generated artifacts are ignored and are not part of the source change:

- `relay/collector/build/Alfred Sync.app.zip`
  SHA-256 `54cbfabc2583f76b0a083f7bf85788ff8a632d8b46b797d412f4c449b7721805`
- `relay/collector/build/Alfred Sync DEVELOPMENT.pkg`
  SHA-256 `487fa5b7ad08cb66a8106c3e0cc571c136b7f0a7295dc144d6747831fcd2227d`
- Build evidence: `relay/collector/build/final-verification-summary.json`.

The app is an ad-hoc development candidate. Developer ID signing, notarization,
Gatekeeper behavior and general distribution are not verified.

## Remaining runtime and server work

At the initial build checkpoint, no app installation/launch, Full Disk Access
grant, service registration, real Messages access, forwarding-key entry, real
alert forwarding or notification delivery had been performed. The approved
window-opening check below happened afterward; actual service behavior and
permissions still require their own review and approval.

The live Settings reads still returned unavailable errors for notification
settings and Mac status. Those generic responses do not identify a particular
missing table. No authorized production catalog or migration ledger was
available, and no live schema/configuration change was made. Missing push keys
alone do not explain these GET failures.

The new account-check response includes actual catalog-backed setup readiness.
Automatic operation refuses an older endpoint or unavailable required schema.
The outgoing-notice migration is the eighth reviewed automation migration; the
live ledger must be reconciled before proposing any schema action. Push keys and
recovery scheduling are separate from private chat capture.

The reviewed initial commits were published as draft PR #27 at `52fd5fb` with the
user's explicit approval. Both GitHub Actions jobs (web regression/build and
pure macOS collector fixtures) passed in run `41708352223`. That is synthetic CI
evidence, not a live setup result. No manual deployment, live database change
or activation was performed. Subsequent changes require review before pushing.

## Approved opening: runtime follow-up

After the user specifically approved opening the development app, the verified
archive was extracted to a temporary review location and opened through the
normal macOS app API. The control tool timed out, but the user's screenshot
confirmed that the actual native setup window opened. No alternate launcher or
security bypass was used. Nothing was installed into Applications.

The screenshot showed no confirmed account/access and a stopped background
status. The bundled service file is present and signed; the UI had incorrectly
treated the OS's `notFound` result as proof of a missing/corrupt package. That
result alone does not establish the reason for the unresolved service status.
The temporary review location and development signing are unverified possible
contributors. The local correction distinguishes an unresolved OS registration
from an actually invalid embedded service. One normal registration attempt is
available only behind the existing explicit Start/account/server/access checks.
Missing/changed resources remain blocked, and failed or still-unconfirmed
registration keeps the durable activation disabled. Pause revokes consent before
attempting to stop Alfred's own service even if OS status is unresolved. Blank
Connect now prompts for a key before clearing the input. Twenty-four additional
synthetic assertions cover these cases; the complete native suite now has 497.
The corrected candidate was rebuilt and its signatures, archive round trip and
copy-only installer contents reverified. It was later prepared for the user to
open manually when computer controls were unavailable. The user then supplied
a screenshot showing their account connected and the server-readiness gate
still refusing Messages access. That confirms the setup-window connection path,
not capture or background delivery. The remote main at that checkpoint remained
`bb0f978`, whose account response lacks the new setup-readiness fields in PR #27.
This client/server mismatch does not prove that a particular database table is
missing. Generated candidates remain local; none was installed by the agent.

No service registration, permission grant, actual Messages read, forwarding-key
entry or delivery was performed by the agent. Actual automatic operation is
still unverified; the UI screenshot is evidence of the window opening only.

## PR review follow-up

Claude's four review findings were independently checked and addressed locally:

- A closed money-out notice no longer blocks every later transaction. One
  grounded, clearly separate expense or income request gets its own confirmation.
  Potential duplicates of the captured principal, fee and gross amounts remain
  blocked. Unresolved external matches and ambiguous financial wording require
  an explicit new topic. Owned source lookups are bounded; no transaction-history
  scan or shared cache was added.
- Actual server-open payment questions, owner isolation and the latest displayed
  confirmation continue to override stale client metadata. Only one grounded
  action can escape the notice context; multiple model actions, invented details,
  signs, conflicting currencies and unsupported dates remain held. A non-vacuous
  regression confirms `GHS5` can reach confirmation while `GHS5 USD` cannot.
- Recovery selection now agrees with the generator and atomic writer about card
  holds/settlements. Ten unsupported incoming rows or ten unsupported owners
  cannot crowd out newer valid announcements. Unsupported source rows remain
  unchanged and receive no receipt; valid recovery stays idempotent.
- Start/Pause wording now states that eligible alerts received while paused are
  caught up on resume. Alerts older than 24 hours may update records or Review
  without a chat announcement. Messages before the first Start stay excluded.
  Capture, baseline and service behavior were not changed.

The final focused chat run passed 226 tests across five files. The complete
application run passed 1,497 tests, TypeScript, production Webpack build and
lint (zero errors, three existing unused-variable warnings). One earlier full
run found the old “No historical backfill” wording assertion; it was updated to
the first-Start/catch-up contract, and the final full run passed. Disposable
synthetic audit probes were preserved outside the application's lint/typecheck
tree. The 381 SQL assertions, nine archive tests and 40 activation-rehearsal
assertions also passed. The verified native inputs and generated ZIP/installer
hashes still match after reconnection.

No new browser or native UI interaction was performed during this follow-up.
Conservative phrasing such as “I got paid…” can still require clarification or
an explicit new topic; Claude accepted that as non-blocking. These review fixes
were prepared locally for review and have not been pushed or activated at this
verification checkpoint.
