# Stored accounting display model

This change stores the canonical accounting display in private, queryable tables.
Unchanged cold application instances read a fresh publication and selected rows or
aggregates without loading history or calculating its full source hash. Financial
actions, exports and native import/Undo retain authoritative sources and guards.

## Freshness and publication

`20261105182432_durable_accounting_display.sql` adds the private `alfred_display`
schema. Statement-transition triggers on `transactions`, `bank_messages`,
`imported_finance_sources`, `account_rule_states` and `accounting_states` append
one dirty event per owner and database transaction. Owner changes invalidate both
owners; rollback also rolls back invalidation. TRUNCATE increments a global epoch.

Exact committed dirty-event identities replace a shared counter-row lock. Bank
and rule writers lock source rows in different orders; adding the same counter
lock inside both can cause a deadlock. Sequence allocation is not commit order:
consuming a maximum ID could miss a later commit with a smaller ID. Exact captured
sets avoid both hazards without adding a shared lock to financial source writes.

A durable owner lease serializes rebuilders. Capture finishes before the uncached,
source-coherent canonical loader starts. Existing TypeScript projectors generate
queryable movement, snapshot, transfer, settlement, evidence and ledger facts plus
compact account summaries. Publication verifies the lease, exact captured events,
epoch and publication revision, then replaces the complete owner projection
atomically. Failed insertions, expired leases, partial batches and lost responses
cannot publish an older result as current. Rebuilding inside a transaction that
has changed financial sources is rejected.

Every resource query checks freshness and selects facts in one SQL snapshot.
Dirty, missing or incompatible models never mean an empty ledger or zero balance.
A miss attempts one owner-scoped lazy rebuild and requeries; another worker is
awaited briefly through cheap manifest checks. If no fresh model is available,
the API returns an explicit updating state (202), and Accounts hides its old view.

This is a stored whole-owner projection, not a row-by-row incremental engine. A
mutation still needs one canonical rebuild, lazily or by a worker. Unchanged cold
instances no longer repeat it. Transfer partners, source claims, reconciliation,
returns, rule changes and Undo require a separately proven dependency closure
before a movement-only incremental update would be safe.

## Pages and financial boundaries

Accounts selects 25 matching rows with complete history available through
pagination, filters, search, attention, details and settlement editing. Overview
selects its first 15 rows and separate complete totals. Chat display context,
Settings planning data and investment cash balances use fresh aggregates. Budgets,
goals, bills, loans, profiles, investments and connection metadata remain fresh
independent resources rather than becoming frozen accounting facts.

Stored ordering ranks and normalized search keys preserve canonical JavaScript
ties, filtering and search semantics. Overview ledger facts use
`projectAccountingTransactions()` then `toLedgerRows()` and receipt handling.
Primary-only subscription reporting has a distinct contract. Nullable balances
and reconciliation uncertainty remain explicit.

Assistant financial proposals, confirmations and authoritative finance reports
still read canonical accounting state. Display facts never become a mutation
base. Exports retain complete sources, historical audit before-copies and native
import guards. The original hash and writer ABI remain unchanged. Contrary to the
suspected gap in the brief, the current source hash already includes account rule
state: actual SQL tests verify a rule write changes it without changing accounting
revision. The new display invalidation separately covers those writes.

## Compact saves and Undo

`20261105192204_compact_accounting_writes.sql` adds a transport wrapper around
the existing financial writer. Normal saves load complete current financial data
with historical audit before-copies stripped before network transfer. The reducer
still produces the full before-copy for the new action. Under the original owner
advisory and row locks, the wrapper verifies historical audit metadata, reattaches
its authoritative before-copies in PostgreSQL, then delegates to the unchanged
validator and compare-and-set writer.

Undo loads only its exact eligible before-copy, guarded by owner, revision, audit
position and metadata. Permanent request IDs, source checks, repeated Undo,
uncertain-save behavior and complete event/export history retain their contracts.
Absent the compact migration, saves retain the original full-state path.

This reduces database/application transfer and JavaScript parsing. PostgreSQL
still reconstructs and writes the full JSONB state internally. Audit storage is
not normalized or moved to event-only history by this migration.

## Bank completeness and pool recovery

Canonical accounting now reads every owner-scoped bank message. The recent-message
UI keeps its 200-row window. Using that window as complete accounting history
could mark older movements missing after message 200. Tests cover old categories,
transfer legs, fee-only changes, deletion and reappearance. Owners above that size
may see corrected derived totals. This cannot automatically restore an override
already replaced by a persisted missing-source tombstone; repairing that requires
separate historical evidence and review.

Healthy saturated connection pools can wait within the eight-second acquisition
budget. New connection attempts remain bounded to two seconds. Queue pressure no
longer retires healthy active clients or resets DNS. Late unused clients return to
healthy pools and are destroyed for retired pools. SQL that has started is never
replayed, including an uncertain write.

## Rollout and operation

No production schema, data, flags or deployment is changed by local testing.
Obtain the owner's explicit approval before applying either reviewed migration.

1. Apply both migrations only after approval, using the normal migration runner.
   Verify migration receipts and `alfred_display.readiness()`. New objects use
   invoker security, private backend access and RLS, with no browser-role access.
2. Deploy separately. `ALFRED_DURABLE_DISPLAY=true` enables stored reads; its
   default is off. Only an actually absent additive schema permits the original
   canonical fallback. An installed dirty projection never permits stale totals.
3. Lazy rebuilds work without a scheduler. Proactive rebuilding additionally needs
   `ALFRED_DURABLE_WORKER_ENABLED=true` and an explicitly operated worker:

   ```sh
   node --import tsx scripts/rebuild-display.ts --run --max-owners=1 --continuous
   ```

   The CLI does not load `.env` files or migrate. Continuous mode polls every five
   seconds and requires a supervisor. Alternatively an authenticated scheduler can
   call `GET /api/cron/display` with the configured `CRON_SECRET`; each invocation
   awaits one rebuild with a soft work budget and a 60-second route duration.
   Individual database calls are awaited, not cancelled or replayed by a timer;
   the work budget is not a hard wall-clock guarantee. This PR adds no cron schedule.
4. Monitor `alfred_display.status()` for readiness, dirty/queued/leased/failed
   owner counts, backlog age and worker/publication timestamps. Expired leases
   allow crash recovery. Failure metadata contains generic codes, not financial
   payloads. Bounded cleanup removes orphans, never financial source data.
5. Disable the read flag to roll back application behavior. Retain the additive
   schema pending a separately reviewed cleanup. Source-trigger/projector changes
   require a versioned migration and rebuild. Maintenance that disables triggers,
   restores sources or suppresses triggers must invalidate the global epoch before
   reads resume. Catalog checks detect current drift, not a past
   disable/write/reenable sequence.

Publication bounds are 400,000 rows and 64 MiB, with per-row/manifest bounds.
Oversized models fail closed rather than truncating history. Whole-owner rebuild
cost and inactive-owner backlog still require monitoring; an endpoint alone does
not provide worker liveness.

## Validation and measurement

Actual migrated SQL is compared with canonical projectors for owner isolation,
all five invalidation sources, pagination, worker publication and accounting
behavior. Large fictional fixtures exercise fresh stored reads while source-table
SELECT is denied and the old full-history hash raises. Local SQL/CPU measurements
are distinct from browser navigation and production network latency.

The coherent Accounts fixture contains 2,315 movements, 2,277 snapshots, eight
accounts, 200 transfer links and four audit before-copies, backed by matching SQL
sources. Its returned 27,038-byte Accounts DTO is exactly equal on both paths.

| Same fictional SQL dataset | PR58 display path | Stored rows |
| --- | ---: | ---: |
| Three cold-wrapper median, local ms | 113.143 | 3.924 |
| Seven cache-warm/repeated reads, local median ms | 39.957 | 3.480 |
| Cold read SQL calls | 8 | 1 |
| Cold SQL response compact JSON bytes | 4,900,123 | 27,520 |

Old cold wrappers reset the process display cache; old warm reads prime it once
outside timing. New wrappers use no accounting process cache. Database/module
caches are warm, and wrappers are objects in one process, not new OS processes.
The source-coherent rebuild plus publication took 632.254 ms locally. Results are
reproducible with `tests/durable-canonical-performance.test.ts` and the optional
`ALFRED_DURABLE_CANONICAL_PERFORMANCE_OUTPUT` artifact setting.

On the separate 2,315/2,277 display-publication fixture, local persisted resource
SQL medians were Overview 96.3 ms, Insights 13.3 ms, account cash 0.6 ms and
Accounts 3.6 ms. This fixture tests actual SQL publication/read contracts but
does not seed its complete source history into SQL. Its test explicitly labels
that distinction. The compact-save fixture with eight audit before-copies reduced
the normal state read from 37,423,661 to 4,161,213 bytes; write input fell from
41,581,885 to 8,319,437 bytes and its response to 4,161,631 bytes. These are
fictional compact JSON measurements, not compressed production transfer sizes.

The real PostgreSQL harness creates only a new temporary local cluster: private
Unix sockets, TCP disabled, durable WAL settings, no database URL or application
configuration. It covers multi-session source commits, lease expiry, concurrent
publication, rollback, actual import/Undo, permanent request IDs, process death and
crash recovery. All 20 checks passed on PostgreSQL 17.11, with the complete current
migration chain, and the fixture server was stopped. With PostgreSQL binaries installed:

```sh
node scripts/test-durable-postgres.mjs --bin-dir /path/to/postgresql/bin --output /tmp/alfred-durable-real-pg.json
```

The live before numbers in the brief are reviewer-supplied: Accounts API 2.0/4.2 s
cold and about 0.48 s warm. Production after numbers and the roughly 0.8 s target
require an approved migration, enabled deployment and subsequent read-only browser
measurements. Local fictional tests alone cannot establish them.
