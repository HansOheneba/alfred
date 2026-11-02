# Alfred development UI and accounting workspace

The `dev` branch contains the dashboard UI study and the financial-account,
reconciliation, refund and loan-repayment implementation.

## Run the synthetic preview

```sh
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3016
```

- Overview: http://127.0.0.1:3016/ui-preview
- Accounts: http://127.0.0.1:3016/ui-preview/accounts
- Subscriptions: http://127.0.0.1:3016/ui-preview/accounts?tab=subscriptions
- Chat: http://127.0.0.1:3016/ui-preview/chat
- Notebook: http://127.0.0.1:3016/ui-preview/chat?panel=notebook
- Original dashboard comparison: http://127.0.0.1:3016/ui-preview/current

Preview routes are available only in development and return 404 in a production
build. All preview records are invented: Alex, fixed 24 October 2026, GHS.
Changes persist in namespaced browser storage and never call the application APIs.
The two initial included cash snapshots total GHS 14,318.15. Extra synthetic
records allow transfers, partial refunds and multiple loan repayments to be tried.

A loopback URL opens on the computer hosting the server. It does not expose the
preview to another device. No tunnel or public deployment is configured here.

## UI behaviour

The floating navigation links Chat, Overview, Accounts, Investments and Settings.
Review's classification work is in Accounts → Needs attention. Notebook opens as
a keyboard-accessible drawer within Chat. Legacy Review and Notebook routes
redirect to their new locations.

The overview includes reported cash balances, red spending and green income,
a weekly comparison, insight rows with an in-place Ask Alfred composer, charts,
budgets and transaction details. Desktop tables and mobile cards are retained.
Subscriptions reuses Bills & renewals; synthetic changes are shared with Overview.
The interface follows the spacing, typography and control rules in `ui-rules.md`.

## Production account implementation

The real `/accounts` page uses the owner-scoped `/api/accounting` endpoint. The
same pure domain powers the synthetic preview and the persisted implementation.
The additive migration is:

`supabase/migrations/20261102160000_financial_accounting.sql`

The migration must be applied explicitly through the project's normal database
process. It is not executed by build or by publishing this branch. Until the
migration exists, Accounts reports storage setup is required and rejects saves;
legacy reporting remains available. This work has not applied a live migration.

- Stable account identities and inclusion flags determine the reported cash total.
  Missing included snapshots make that total unknown. Provider names alone never
  assign historic messages to an account.
- Reconciliation compares account-bound source snapshots with original movements.
  Unknown timestamps or unassigned movements are reported as incomplete coverage.
- Paired own-account transfers exclude principal from income/spending and retain
  fees. Partial refunds restate the original purchase period. Linked loans keep
  principal separate and track outstanding amounts; excess repayment remains income.
- Source evidence is preserved. Financial mutations have owner/source checks,
  revision conflict handling, permanent request idempotency, audit and sequential
  undo. Read-only projections are separate from source editing and ingestion.
- Existing old-style refund/loan classifications remain intact and must be undone
  explicitly before the same records can be linked again.

Money handled for other people and unrelated income-planning features are deferred.
Authenticated live persistence and real multi-session lock contention have not been
exercised by the synthetic tests.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

The nine SQL persistence tests run against PGlite in an isolated synthetic
PostgreSQL engine. They run when `@electric-sql/pglite` is available locally, or
when `ALFRED_PGLITE_MODULE` points to its installed ES module:

```sh
ALFRED_PGLITE_MODULE=/absolute/path/to/pglite/dist/index.js npm test
```

Without that optional test tool those nine tests are explicitly skipped. An
invalid explicit module path fails instead of silently skipping. The tests never
load a live database URL or application configuration.

The local verification run passed 376 tests across 35 files, including all nine
SQL tests, TypeScript, ESLint and the production build. Browser checks covered
320–1920px, mobile/desktop light and dark modes, keyboard/focus, financial links,
subscription editing, scrolling and cross-screen consistency. No preview API
requests, runtime errors or unintended horizontal overflow were observed.

Screenshots, Library upload metadata and machine-specific browser capture scripts
are local review artifacts and are excluded from Git. No credentials or real
financial records belong in the preview fixtures.
