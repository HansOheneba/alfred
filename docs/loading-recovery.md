# Loading recovery and bounded page reads

These local changes reduce repeated accounting work and history sent to each page. They were integrated with main through `2f7091e5e032b5253c2d9a8a2b5634e43cbeaddd`, including PR56 confirmation handling and PR57 chat sorting. No earlier local learning experiments were included. No migration is required.

## Page coverage

| Page | Initial read and preserved behavior |
| --- | --- |
| Overview (`/dashboard`) | Exactly 15 recent transaction details, separately computed complete totals/charts for every preset period, and paginated full history. Owner, filters, source version and revision bind every cursor. |
| Accounts | Complete balances, reconciliation, counts and filters, with 25 detail rows per page. Activity, attention, snapshots, transfers, settlements and selectors remain accessible through pagination. Raw source text loads only when opening evidence. |
| Investments | One coherent portfolio-input query, reused contributions, parallel independent quote feeds and a page-only two-second remote quote budget. Existing cache dates, reported values and unknown-value presentation remain visible. |
| Chat | Compact month totals, trends, budgets, insight, cash and waiting-payment preview. History can establish that no answer-choice request is needed. Main's chat sorting remains intact. |
| Settings | Budgets, goals and bank resources load independently. Rules read bounded account data instead of the complete accounting state. Existing preference and financial writers remain intact. |
| People, Notebook, Review | Existing redirects to Chat or Accounts use the corresponding bounded destination reads. |
| Home, Login, Signup | Authentication and form behavior remain intact; the shared profile/readiness read uses one statement. |

Accounts retains account configuration, manual balances, category creation/selection, movement corrections, transfer pairing, settlement editing, bulk classification, grouped Undo, receipt navigation and Start review. Settlement editing retrieves the complete existing plan (up to the existing schema limit) and appends exact references rather than replacing earlier repayments. The legacy full workspace remains available for existing preview flows.

Both paginated interfaces reject stale results and session changes. Accounts serializes page reads against saves, checks the authenticated owner before a command body is read, and validates the acknowledged owner, request and revision. Client deadlines include response bodies. An uncertain save requires recovery; it is never automatically replayed. Full accounting writes, Undo, exports and audit-before history remain uncached.

## Accounting and connection recovery

Per-call indexes replace repeated linear searches without weakening validation or changing financial results. Display-only accounting reads can reuse a process-local snapshot only after one fresh owner-scoped SQL statement matches both its saved revision and complete source version. Source/rule/import changes invalidate it. Stamp failure fails the read; stale data cannot be returned. Cloned results are isolated by database and owner, with at most eight entries, 8 MB per entry and 32 MB total serialized size. The 60-second TTL bounds memory, not freshness. These are serialized limits, not measured JS heap limits. Cold instances still perform the complete coherent source read and validation.

The exact uncoded pg-pool checkout timeout is reproduced locally. Previously it failed after 8,000 ms without reaching an available fallback. It now reaches the healthy fallback after 2,000 ms and sends SQL once. DNS and checkouts share an 8,000 ms acquisition budget. Pool/socket errors invalidate the affected connection safely. SQL, transaction work and COMMIT are never replayed after execution may have begun. This bounds acquisition; it does not add a general SQL execution timeout.

The Investments two-second budget covers remote quote waiting, response bodies, FX fallback and the sequential capped US group, excluding preceding/following database work. Late quotes cannot populate the cache; accepted cache writes are awaited. Chat, saves and scheduled refreshes keep their existing quote behavior.

## Measurements

A read-only production aggregate verified 2,315 saved movements, 2,277 snapshots and 4,306,787 bytes of audit-stripped jsonb text. Full saved state, including Undo before-copies, was 34,363,263 bytes. This confirms large stored data; it does not measure HTTP bytes or prove a 1.5–2.5 second CPU rebuild. No private source text was fetched for that measurement.

The following compact JSON equivalents use one entirely fictional fixture with 2,315 movements, 2,277 snapshots, eight accounts and four Undo before-copies. Its baseline already includes the initial query-batching improvements; it predates bounded DTOs, CPU indexes and validated display reuse.

| Page/resource | Before bytes | After bytes | Detail bound |
| --- | ---: | ---: | --- |
| Overview | 1,007,427 | 62,477 | 15 of 1,915 canonical report rows |
| Accounts | 3,056,774 | 28,184 | 25; complete movement/snapshot counts |
| Chat context | 1,007,255 | 1,751 | Aggregates and three waiting previews |
| Settings budgets | 1,007,255 | 123 | Section-specific data |
| Settings goals | 1,007,255 | 98 | Section-specific data |
| Settings bank | 1,007,255 | 198 | Section-specific data |
| Investments | 1,220 | 1,220 | Existing portfolio output |

This fixture has no budgets, goals, investments or account rules; the small section sizes do not predict populated sections. A separate portfolio fixture has 250 investments and 5,000 contributions: store queries fall from six to two. Six one-second quote feeds take four seconds rather than six with default refresh behavior; the page additionally has its two-second budget.

The actual loader graph also runs with a three-client FIFO pool and synthetic 100 ms SQL/auth latency. Warm hits still check freshness in the database.

| Resource | Final cold SQL / model ms | Final warm SQL / model ms |
| --- | ---: | ---: |
| Overview | 16 / 900 | 8 / 500 |
| Accounts | 10 / 800 | 2 / 300 |
| Investments, cached quotes | 12 / 800 | 4 / 400 |
| Chat context | 16 / 900 | 8 / 500 |
| Settings budgets | 11 / 800 | 3 / 300 |
| Settings goals | 2 / 300 | 2 / 300 |
| Settings bank | 12 / 800 | 4 / 300 |

In the original empty-owner model, Chat and Settings server data remain at 200/300 ms despite fewer statements. One progressive Chat subset falls from two HTTP requests/five SQL calls to one/two; its entire deferred pipeline still takes 700 ms because another check finishes last. This does not establish that all Chat startup halves.

Pure accounting medians in the populated fixture improve from 8.3 to 1.2 ms for hydration, 23.3 to 5.3 ms for balances and 25.8 to 7.6 ms for the complete view. It does not reproduce a seconds-long CPU rebuild. Accounts moves display math to the server: its zero-RTT loader median was slightly higher (20.1 to 22.3 ms) while the browser payload became much smaller. Phase times overlap and cannot be added.

## Reproduction and limits

Run the complete suite with `npm test -- --maxWorkers=2`. Benchmarks write reports only when the corresponding output variable is supplied:

```sh
ALFRED_PAGE_BENCH_OUTPUT=/tmp/page-loads.json npm test -- tests/page-load-performance.test.ts
ALFRED_POPULATED_CPU_OUTPUT=/tmp/accounting-cpu.json npm test -- tests/populated-accounting-performance.test.ts
ALFRED_POPULATED_PAGE_OUTPUT=/tmp/page-payloads.json npm test -- tests/populated-page-performance.test.ts
```

Run CPU and page benchmarks separately for cleaner samples. The review bundle includes raw JSON reports, captured populated baseline source and `benchmark-method.md` with fixture/sampling details. All benchmarks use fictional data and reject unexpected writes/network access.

These controlled source-loading measurements are not browser paint/LCP, compressed HTTP traffic or measured production latency. Real database execution, cold deployment starts, assets, hydration and bandwidth are outside the model. Display reuse is per running instance and is not guaranteed across serverless requests. Cold coherent reads still transfer the full source set. The supplied network timeline did not label individual requests.

The changes are local for review. They do not modify production, retry/cancel pending confirmations, or change category/budget records. Main's reported 46 real-model evals were not rerun as part of the local performance suite.
