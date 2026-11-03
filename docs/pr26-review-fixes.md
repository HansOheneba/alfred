# PR 26 review fixes

Local follow-up to Claude's **18:05, 3 November 2026** review in
`task-5/sms-push-review-fixes-handoff/COORDINATION.md`. Reviewed PR head:
`71d5f8a4d69d3e5aa87533502d2cd69c6fe31eed`. Original notes, patches, Claude's
worktree and other app checkouts were read-only throughout this follow-up.

## Findings and resolutions

1. **Old Mac status entries permanently consume the five-device limit.**
   Confirmed. Add **Remove saved status** to Automations with a confirmation
   naming the selected Mac and last check-in. The separate DELETE endpoint uses
   session ownership, exact same-origin consent, a displayed-account fence and
   a strict bounded UUID-only request. The forward
   `20261103230000_collector_health_removal.sql` function locks the same owner
   namespace as reporting and removes only that owner's selected status. Repeat
   removal is idempotent. Existing Macs are not automatically evicted. Keys,
   local alerts and financial records are untouched; the UI explains that an
   active Mac can check in again. Late responses and old confirmation handlers
   cannot operate after an owner change/unmount or duplicate an in-flight action.

2. **Chat-mention recovery failure still records a successful heartbeat.**
   Confirmed. Failed mention recovery now reaches the dispatcher's failure path,
   records failed health and returns 503 before notification dispatch. Completion
   is recorded only when both recovery tasks succeed. Existing queued work stays
   available for a later healthy run. Real in-memory PostgreSQL tests prove that
   a recent healthy heartbeat becomes unhealthy, successful retry restores it,
   a first failure never fabricates success, and push-dispatch failure also
   invalidates health. Errors expose no original receipt details.

3. **Collector identity/health endpoints lack abuse throttling and rejection logs.**
   Confirmed. Both endpoints share limits before identity lookup or health-body
   processing: 1,200/minute overall, 120/minute advisory client bucket and
   60/minute key bucket. Fixed hash slots bound counter cardinality to 4,354
   possible buckets even when keys/headers rotate. Header values never establish
   identity. Collisions only reject earlier; they can throttle unrelated callers
   conservatively. Logs contain a fixed endpoint/reason only. Missing limiter
   storage fails closed; errors remain private and no-store. Account identity
   lookup remains SELECT-only, with operational rate-counter writes documented.

Claude's CI/preview observations were not additional defects. The original
published PR head now has successful GitHub web and macOS jobs. Those results
do not establish hosted CI for this unpublished follow-up. The existing Vercel
access restriction was not investigated or changed.

## Verification

- **1,394 tests across 124 files passed** on the combined local runtime source.
  This includes direct lifecycle/handler regression cases and actual PostgreSQL
  limiter SQL for threshold, expiry/reset, global cap and deliberately colliding
  synthetic keys.
- **381 PostgreSQL portability assertions**, **40 activation assertions** and
  **9 archive tests** passed. The activation rehearsal and read-only preflight
  now cover **seven** unapplied drafts, including the new removal function.
- Next.js route type generation, TypeScript, full ESLint and Webpack production
  build passed. ESLint retains three existing unused-variable warnings in
  unrelated tests; no errors.
- Native pure fixtures passed: **235 collector, 53 identity, 59 health and
  56 held-review assertions**, plus **9 policy and 11 packaging tests**. Legacy
  fixtures passed **79 assertions and 20 installer tests**. The production relay
  compiled without execution; the runtime sandbox probe stayed disabled.
- Independent review found no remaining ownership, financial-record or
  rate-bypass blocker. In-memory tests do not prove multi-session load behavior.
- Background browser checks on the existing sample server at
  `http://127.0.0.1:3121/preview/automations#automations` passed: show review/stale
  samples, open confirmation, cancel retains the row, confirm removes the
  fictional status and shows an honest sample-only success. The mobile dialog
  fits 390×844 with page width 390 pixels. Choices/viewport were restored and
  the browser error log was empty. No real account endpoint was invoked.

## Release boundary

No fixes were pushed, no PR comment/body was changed, and no merge, deployment,
live migration, key change, Messages access or real notification was performed.
Before release, review the actual database ledger and include the seventh draft
through the established migration workflow. An unapplied removal function returns
an unavailable error rather than pretending to remove status. All prior signing,
Mac permissions, scheduler, device-consent and actual-delivery limitations remain.
