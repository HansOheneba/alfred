# Finance data coverage

An export includes a coverage report. Preview reports what the destination can activate and what remains saved. Source coverage does not itself grant activation permission.

## Common accounting

| Data | Active behavior | Boundary |
| --- | --- | --- |
| Accounts and category labels | Preserve saved labels, currency, stable identity and cash inclusion. | Account names are not inferred from a bank or provider. |
| Movements | Preserve principal, separate fees/taxes, status, date, source evidence and category provenance. | Unknown or ambiguous source semantics stay saved; import does not enable future collection. |
| Reported balances | Preserve dated balance evidence. | An incomplete transaction history never becomes an invented opening balance. |
| Own transfers | Preserve explicitly linked outgoing/incoming principal and separate fees. | No amount/name matching creates a new transfer link. |
| Refunds and loans | Preserve exact links and partial principal allocations. | Fees/taxes are not consumed by settlement offsets. Exact duplicate native-loan/accounting source representations block preview. |

## Alfred native features

| Domain | Active behavior | Saved or restricted behavior |
| --- | --- | --- |
| Budgets | Restore monthly category/currency amounts. | Different amounts for an existing semantic budget are conflicts. |
| Savings goals | Restore recorded targets, progress and status. | A goal is not a bank balance or a new cash movement. |
| Bills | Restore representable recurring and one-off bills, initially paused. | Original delivery state remains evidence. |
| Investments, holdings, values, contributions | Restore the linked graph, financial status, known quantities/costs and dated values. | Notices start paused. Original bank-message links remain evidence; active contribution links are cleared. Unknown cost basis produces unknown gain. |
| Legacy loans | Restore lent/repaid/borrowed/paid-back entries in person balances. | Original bank-message links remain saved; active links are cleared. |
| People and payee rules | Restore notes and deterministic filing rules with consistent links. | Destination conflicts block overwrite. Filing rules can affect future messages. |
| Notebook | Restore plain notes. | Account-bound exclusion notes remain saved because they change future message filtering. |
| Historical messages | Restore owned conversation history without replaying actions. | Delivery client IDs are cleared. Pending actions are excluded. |
| Account rules | Restore exact owned account scope, merchant, direction, priority and effective date. | Ambiguous account references remain saved for review. Provider names never imply account ownership. |
| Raw transactions and bank messages | Preserve original source evidence; supported economic records activate through accounting. | The native bank-message review/history list is not replayed from imported raw rows. |
| Accounting/audit/undo history and prior receipts | Preserve original evidence and provenance. | Destination revisions and executable undo history are not replaced. Older receipt hashes keep their original conservative guard; an upgrade does not unlock old undo by rehashing it. |

## Money Tracker mappings

| Source | Existing Alfred feature | Remaining source meaning |
| --- | --- | --- |
| Monthly category limits | Budgets; complete plans also become source-referenced Notebook notes. | Overall limits, income intentions and repeat behavior remain saved. No achieved savings is invented. |
| Confirmed bills | Representable Bills records, initially paused. | Zero-price or otherwise unrepresentable bills remain notes/evidence. |
| Payment notes and purposes | Notebook entries with source references. | Unsupported override fields remain in the archive. |
| Account-specific category rules | Shared app/bot rule store after a unique account mapping. | Ambiguous scope remains Awaiting support; future SMS matching needs an explicit provider/suffix/currency binding. |
| Named portfolios | Investments with dated reported values and explicitly known holdings/costs. | Unknown basis, undated values and unsupported positions remain explicit. Allocation percentages never become share quantities. |
| Third-party groups and audit | Saved records with their relationships. | Alfred has no equivalent allocation feature. |
| Prompt/digest/reminder preferences | Saved source evidence. | Import does not enable a schedule or delivery connection. |

## Settings and exclusions

Preferred name, currency, timezone, reply preference, financial goals and reminder times use field-specific default checks. Different non-default destination choices are kept and listed as preserved without blocking the finance import. Invalid settings still block confirmation. Account names used by bank collection and reminder enabled flags remain saved rather than changing future collection or delivery.

The supplemental browser dataset contains only appearance, amount privacy and home-screen preference. Legitimate writers, import and undo share a Web Lock. Preferences remain saved when safe locking is unavailable. Financial commit and device preference writes are separate; later edits or uncertain/partial device outcomes prevent automatic overwrite.

Credentials, source ownership, passwords, sessions, OTPs, forwarding keys, Telegram connections, push subscriptions, machine paths, pending executable actions, rate-limit/processed-update claims and delivery queues are excluded. Shared market/FX caches and administrator assistant-tone notes are also excluded. Legacy rows whose owner cannot be established are not assigned by guessing.

Unsupported records remain recoverable through Awaiting support and future exports. Current adapters can review documented retained wrappers without replaying nested cash movements. Activation always requires a new review and confirmation; it is never automatic.

Runtime import support requires the forward `20261102190000_portability_review_fixes.sql` migration after the unchanged accounting, rule and portability baselines. New receipt guards ignore unrelated chat and delivery metadata while protecting later financial edits. Existing version-1 receipts retain their old guard, so ordinary chat can still block their undo. See [setup and rollback requirements](data-portability.md#database-setup) before a live release; no migrations are applied by an export, preview or local test.
