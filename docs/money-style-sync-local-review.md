# Money-style Alfred Sync: local review

Prepared 3 November 2026 from merged main `bb0f978` on
`fix/money-style-sms-setup-20261103`. This follow-up is local only.

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

- Application: 1,433 tests across 127 files passed. A subsequent test-only wording
  correction passed all 14 focused copy/guard tests; runtime source was unchanged.
- Typecheck, Webpack production build and whitespace checks passed. Lint had zero
  errors and three existing unused-variable warnings.
- Portability SQL: 381 synthetic assertions passed across the existing integration
  suites; archive: nine tests passed.
- Eight-file automation migration rehearsal: 40 in-memory assertions passed.
  Catalog-only readiness also tested old-schema refusal, new-schema acceptance,
  missing-function refusal and no financial/preference creation.
- Native: 473 synthetic assertions, nine policy tests and 13 packaging tests
  passed. Optimized compilation, declared entitlements, ad-hoc signing, archive
  round trip, copy-only installer contents and bundled service scope passed.
- Desktop and 390-pixel mobile previews showed both announcement directions,
  independent switches, safe outgoing purpose replies and no horizontal overflow.
  Preview console error log was empty. Preview choices were reset afterward.

## Local candidates

Generated artifacts are ignored and are not part of the source change:

- `relay/collector/build/Alfred Sync.app.zip`
  SHA-256 `c6d23a7818fbf31d965e3eba5eb6b7756db7ee4b380502966011c8a3fc824e61`
- `relay/collector/build/Alfred Sync DEVELOPMENT.pkg`
  SHA-256 `642b755d9822cf0517245b61b5b909af5e731f242d40f1cf4a005f4c71f4b49b`
- Build evidence: `relay/collector/build/final-verification-summary.json`.

The app is an ad-hoc development candidate. Developer ID signing, notarization,
Gatekeeper behavior and general distribution are not verified.

## Remaining runtime and server work

No app installation/launch, Full Disk Access grant, service registration, real
Messages access, forwarding-key entry, real alert forwarding or notification
delivery was performed. Native window layout and service behavior on this Mac
remain runtime checks requiring the user's specific approval.

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

Nothing from this follow-up has been pushed, proposed in a new PR, deployed or
applied to the live database. Publication and activation remain separate review
steps.
