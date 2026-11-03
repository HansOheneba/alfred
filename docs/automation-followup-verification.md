# Automation follow-up verification

Local result, 3 November 2026, based on pushed automation commit
`b2e513f89ea4df985b775c1b7690d0bed315c52e`. This follow-up has not been pushed,
installed or activated. Hans remains responsible for merge and deployment.

## Implemented

- An explicit native **Review saved alerts** window, reachable from the inactive
  opening notice and `--review-held`, reviews the existing private outbox only.
  Retry keeps the original event identity, Later retains the payload, and a
  confirmed Not a payment removes only the local pending copy. Server financial
  records are unchanged. Saved account confirmation is clearly distinguished
  from an online verification. More than 100 alerts remain reachable.
- A copy-only development installer and guarded signed release-candidate
  workflow. Packaging validates the final expanded app's exact tree, bytes,
  signature, sandbox declarations and platform. No installation script, launch,
  permission grant, account setup or service registration occurs.
- A read-only production preflight and an exact activation handoff. The
  synthetic activation rehearsal checks six migrations and their ledger rows
  committing or rolling back together. The existing migration runner is not
  represented as a safe, atomic six-file activation command.
- Corrected the portability integration test's replay selection: it now repeats
  only the intended additive forward migration, not every later migration.
- The SMS demo's notification choices now also start off, consistently with
  the Automations demo. Fictional conversation examples remain available.

## Passed on the final local code

- Application suite: 1,330 tests across 118 files.
- PostgreSQL portability suites: 162 + 161 + 58 synthetic assertions.
- Separate activation rehearsal: 40 assertions, entirely in memory.
- Archive suite: 9 tests.
- Type generation, TypeScript and Webpack production build.
- ESLint: no errors; three existing unused-variable warnings in unrelated tests.
- Native pure fixtures: 235 collector, 53 identity, 59 health and 56 held-review
  assertions; 9 policy and 11 packaging tests. Native app build and signature
  verification passed without executing the app.
- Final development installer was built and expanded for inspection. Its
  manifest explicitly reports `releaseReady: false`, `installed: false`,
  `runtimeVerified: false` and `autostartEnabled: false`.
- Independent source review checked owner/event isolation, partial-record
  warnings, pagination, transactional audit and final installer payload checks.

## Browser verification and limits

The already running local sample preview on port 3117 was checked through a
background browser. All four choices toggle independently, save/reset operate
only on the fictional visit, reload starts Automations off, the sample account
mismatch blocks setup, and completing the three-step sample leaves capture off.
Known, unknown and uncertain payment examples render. At a 390 by 844 mobile
viewport the page width was 390 pixels and the payment switch/reset worked.
The viewport and sample choices were restored afterward.

That server belongs to the earlier implementation checkout. The final runtime
code at `9cf713f584ea958115f5563aa42f04875d698507` was subsequently verified on
the separately approved sample-only server at `http://127.0.0.1:3121`, using the
same command, address and normal approval review. The earlier loopback rejection
was retried only after the user explicitly approved that exact preview. No
alternate port or launcher was used.

The final server initially could not resolve dependencies linked outside the
Turbopack project root. Existing locked dependencies were copied into this
isolated checkout without installing new packages. A clean, normally approved
restart on the same address cleared partially loaded module state; no database
import or application source change was needed. All three final demo routes
then rendered successfully. Desktop checks passed for independent switches,
save/reload/reset, the account mismatch block, the full three-step inactive
setup, known/unknown/uncertain examples and the birthday-money sample reply.
All notification choices also start off on the SMS demo. Mobile checks at
390 by 844 passed for page width (390 pixels), switch/save/reset interaction,
and layout inspection. The viewport and choices were restored. The final
browser error log was empty. The background tab was retained as a deliverable.

Hosted-demo browser verification remains incomplete. The native window was
compiled and its state transitions tested, but never opened. No real account,
credential, Messages access, notification permission, financial data or delivery
was used during the final browser check.

## External gates still unresolved

- The existing GitHub integration returned PR creation 403, “Resource not
  accessible by integration.” Fresh read-only search still showed no automation
  PR. No different credential or route was used to evade that denial.
- No authorized production database catalog/ledger result is available here.
  No live migration, notification secret, recovery scheduler or device opt-in
  has been applied. See `automation-activation-readiness.md` and the read-only
  `automation-activation-preflight.sql` for the exact next review.
- Developer ID signing, notarization, disposable-Mac install/update/removal,
  actual Messages/App Sandbox/Full Disk Access verification, account/provider
  connection and explicit service activation remain unperformed.
- Real SMS capture, durable live receipt, new financial-record creation and
  browser notification display have not been proven. Local fixtures establish
  none of those live claims. No real financial records were changed.
