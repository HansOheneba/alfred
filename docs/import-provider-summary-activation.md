# Import identity summary setup

Apply the reviewed pending migrations, including `20261104170000_import_provider_summaries.sql`, through Alfred's normal database release workflow before releasing the matching app. This migration creates compact derived receipt metadata for future imports; it does not replay finance records or backfill old receipts automatically.

For each existing active import receipt, prepare its summary using the existing authorized server database connection:

```sql
select public.alfred_backfill_import_provider_summary('<owner UUID>'::uuid, '<receipt ID>');
```

Run one known owner/receipt per call. `prepared` and `current` are successful and idempotent. `undone` is intentionally skipped. Retry `missing_or_busy` only after checking the intended receipt and active operation. `corrupt` requires reviewing original receipt lineage; do not replace or fabricate source archives.

For an operator preparing the existing project, this bounded batch selects the
actual receipt identities, so users do not have to look up or enter IDs:

```sql
with pending as materialized (
  select owner_id,id from public.finance_import_receipts
  where undone_at is null and provider_identity_summary_version is null
  order by owner_id,id limit 25
)
select owner_id,id,
  public.alfred_backfill_import_provider_summary(owner_id,id) as result
from pending;
```

Repeat for the remaining receipts after checking the results. Stop and inspect
`corrupt` or `missing_or_busy` results rather than running an automatic retry loop.

New imports derive summaries in the same transaction as their receipt. Undo immediately removes their authority; saved account names, providers, IDs, amounts and import replay identity stay unchanged. Reads use compact summaries. Before backfill, at most two legacy receipts can be inspected per lookup; more returns `backfill-required` and missing identity facts stay unconfirmed.

The migration and backfill require the database owner's normal release approval. This code does not apply them, create credentials, activate sync, or modify financial history.
