# Download and import finance data

Open **Settings → Data & privacy** to download a finance ZIP or import one. Export, validation and mapping use fixed code; no AI model reads or classifies the archive.

## Import a file

1. Download the finance ZIP from Alfred or a compatible Money Tracker export.
2. Choose the file in Alfred and select **Review import**.
3. Review the added records, duplicates, conflicts, settings and saved data. Resolve conflicts before continuing.
4. Select **Confirm import**. Financial records, links, source evidence and the receipt commit together.

The archive limit is 20 MB. A preview expires after 30 minutes. Each account may keep up to five unexpired previews. A changed destination requires a fresh preview. Repeating a completed import returns its receipt without adding duplicate records.

Imported accounts and transactions appear in the normal screens. Supported budgets, goals, bills, investments, notes, people and historical messages populate their existing features. See the [domain matrix](portability-domain-matrix.md) for exact mappings and limitations.

Imported bills and investment notices start paused. Review them before using their explicit resume controls. Importing history does not configure SMS forwarding, sign-in, Telegram connections or delivery credentials.

## Saved data and Awaiting support

Records without a compatible destination feature remain in **Awaiting support**, with readable details and their source relationships. You can download saved data and it remains included in later exports.

**Check what can be added** reviews a stored archive with the current deterministic adapters, without another upload. If nothing new is supported, no records change. Available additions require a fresh preview and explicit confirmation. Future feature support and automatic activation are not promised.

Third-party allocations, income intentions and source-specific planning behavior remain saved when Alfred has no equivalent feature. Raw bank-message history is retained as evidence rather than replaying old review questions or notifications. Old source receipts cannot undo destination records.

## Settings and undo

Safe profile fields can transfer only when the destination remains at its defaults. Different non-default profile or reminder choices are kept and listed under preserved preferences; they do not block the financial import. Invalid settings still require review. Reminder clock values can transfer without enabling reminders. Account-name collection controls remain saved for review.

Appearance, amount privacy and home-screen preferences transfer separately on the current device when readable and supported. A device warning does not mean a successful financial import rolled back. Browser storage, the home cookie and PostgreSQL have separate commit boundaries.

Receipts are available in recent imports. Undo refuses to discard later finance, native-feature or rule edits. Resuming imported investment notices also prevents undoing that import. Device preference undo separately checks for later device changes.

New previews and receipts use the reviewed version-2 change guard: unrelated new chat messages, bank-name learning and reminder-delivery markers do not block them. Actual edits to imported financial or feature records still prevent unsafe undo. Earlier previews and receipts keep their original version-1 hashes and conservative checks. Ordinary chat can therefore still prevent undo of an older import. The upgrade never rewrites an old receipt's hash to make undo appear safe; its stored data remains recoverable.

## Database setup

Finance portability requires the existing schema through `20261102160000_financial_accounting.sql`, followed by:

1. `20261102170000_account_rules.sql`
2. `20261102180000_data_portability.sql`
3. `20261102190000_portability_review_fixes.sql`

The published `1700` and `1800` files stay unchanged. The `1900` forward migration installs the review fixes and new completion marker for both existing installations and fresh setups; do not edit or rerun the older files to upgrade an existing database. Import actions fail closed until the complete compatible `1900` schema is present. Existing receipts, archives and stored hashes are not rewritten.

Review these migrations and the configured target database before running `npm run db:migrate`. The command changes that database; tests use an embedded synthetic database instead. An earlier partial draft needs an inspected forward upgrade; rerunning the same filename is not an upgrade strategy. Local tests and source integration do not establish which migrations are applied on a live database. No live setup change is implied by these instructions.

The current migration runner applies a file before recording its filename separately. Apply reviewed SQL and its ledger entry in one checked transaction on one connection when preparing the release. If an earlier attempt was interrupted, inspect the schema and migration ledger before retrying. Completion markers and catalog checks disable imports when the required migration did not finish or its permissions or signatures are incompatible.

Writes run through the server database connection. Destination ownership always comes from the signed-in session. Client roles cannot execute the import or rule-writing functions directly.

After imports exist, a rollback must retain imported-source hydration, account rules and notification pause guards. Preserve source evidence and receipts. An older notification job that ignores imported pause flags must stay stopped until a compatible runtime is restored.

## Development checks

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm run test:portability:archive
npm run test:portability:sql
npm run test:portability:journey
```

The tests use repository-owned fictional fixtures and ephemeral PostgreSQL through PGlite. The journey checks Alfred's actual screen stores, accounting totals, idempotency and recovery from the documented retained-archive wrapper. It does not execute another application's runtime or require another checkout.

See the [archive contract](portability-format.md) and [account-rule commands](account-rule-commands.md). Credentials, sessions, push keys/endpoints, machine paths and operational delivery state are excluded from finance archives.
