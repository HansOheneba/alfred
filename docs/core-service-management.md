# Core service management

This change adds reusable, owner-scoped expense and income categories, a combined category-and-budget conversation, budget removal, bill management, financial account configuration, and existing profile/reminder/notification preferences through the shared web and Telegram chat. Each write reviews its exact effect before confirmation. Some advanced service operations remain outside chat, as listed below.

## Categories and budgets

The shared web and Telegram conversation supports these actions:

| Request | Behavior |
| --- | --- |
| List categories | Shows built-in categories and the requesting owner's saved custom categories, optionally filtered to expense or income. |
| Create a category | Validates a bounded name and type, then asks for confirmation before saving. Built-in names and aliases cannot be redefined. Repeating an existing custom name reuses that category. |
| Create an expense category and budget | Carries the intended category name and amount from the recent conversation. Missing currency or month produces a question. After the details are supplied, one confirmation reviews the category and budget; persistence commits them together. |
| Set or change a budget | Uses a built-in or saved expense category and reviews the amount, currency and month before confirmation. Missing currency or month is not inferred from profile defaults or today's date. |
| Check budget status | Calculates spending and remaining amounts from stored reporting records. A read-only request without a month retains the existing current-month behavior. |
| Remove a budget | Resolves exactly one owner-scoped budget and reviews it before confirmation. Confirmation checks the reviewed values and update timestamp; a changed budget requires a fresh review. Removing a budget leaves transactions intact. |

For example, “Set a budget of 2,000 for Shopping” can be followed by “Create that category and put the budget under it.” Alfred asks for the currency and month if they have not been supplied. Once those details are known, he reviews the combined change rather than substituting another category.

Saved categories are available to category selection and validation in transactions, reporting, budgets, bank-payment classification and account rules. They do not become merchant rules merely because they exist. Category listing in the website is read-only; new categories use the confirmed conversation flow.

Category names are scoped by owner and transaction type. A combined write must use an expense category, the same owner and the same category name as its budget. Arbitrary model text does not extend the saved category set. Storage connections without category-management support report that limitation rather than claiming a save.

Category archiving and unarchiving are deliberately excluded. A created category remains available; the owner may use it or simply stop using it. There is no hidden, inactive or archived category state, no archive control and no automatic rule/budget changes that simulate archiving. Existing built-in category names and aliases remain available.

Renaming remains a separate, unanswered decision because existing records reference names rather than category IDs. A rename must either rewrite owned history and dependent budgets/rules, with a policy for name collisions, or retain old names through aliases and define how reports group them. Renaming, category deletion and merging are not implemented. No historical treatment is inferred from the decision against archiving.

The archive terminology elsewhere in the repository refers to existing finance ZIP export/import files, retained import evidence, receipts and recovery. That behavior is unrelated to category lifecycle and is preserved.

## Bills, accounts and settings

Bills support listing, creation, edits, pause/resume and deletion by exact name or saved ID. Creation requires a due date, currency, cadence and a fixed amount or an explicit variable amount. Duplicate names require an exact ID. Reads distinguish unavailable storage from an empty bill list. The reviewed bill snapshot is compared atomically at confirmation, including precise PostgreSQL timestamps. These operations manage Alfred's expected bills and reminders; they do not pay bills or cancel subscriptions with a provider.

Financial accounts support listing, creation, label/provider edits and inclusion in cash totals. New accounts require an explicit provider, currency and cash-inclusion choice. Confirmations retain the accounting writer's reviewed revision and stable request ID; stale state is not silently rebased. Account configuration does not connect a bank, create a real bank account, record a balance or move money. Existing balance snapshots are preserved.

Profile preferences support preferred name, default currency, timezone, reply detail and financial goals. Default-currency changes affect future defaults and do not convert recorded money. Telegram bindings, sign-in credentials and connections are excluded from chat changes.

Reminder preferences support the existing morning, commute and evening Telegram check-ins. Times are reviewed in the owner's saved timezone, with clarification for ambiguous time wording. Notification preferences support payment mentions, outgoing mentions, payment push, payment preview, bill reminders and weekly overviews. Enabling push/bill/weekly preferences requires the same delivery configuration, policy and recovery-health checks as Settings, checked again at confirmation. Saving a preference does not grant browser permission, register a device, configure a reminder job or guarantee delivery. Arbitrary one-off reminders and new schedules remain unsupported.

Settings writes patch only requested fields and atomically compare the reviewed values/version. They do not call the existing all-settings overwrite path. A successful read of a new profile with no notification opt-in row uses the existing all-off defaults; only confirmation may create the row. Failed reads never produce invented defaults.

New service-management requests review one write at a time. Compound requests containing multiple writes, including an additional clarifying offer, ask which change to prepare first. This avoids presenting several changes under a single unrelated confirmation. Replies scoped to a captured payment cannot turn into these service-configuration writes.

## Existing services and remaining gaps

This inventory describes supported application behavior, not authority to move money through a bank or investment provider. Financial actions record or classify information in Alfred.

| Service | Existing conversation support | Management still outside chat or unsupported |
| --- | --- | --- |
| Transactions and reports | Record expenses/income; history; spending/income summaries; overview and insights; correct and delete records. | Account assignment and detailed movement review use Accounts. |
| Savings goals | Create goals; contribute; change saved amount, target, date or active/completed status. | Rename and delete use the website. |
| Investments | Add; update details, holdings and reported value; close; record contributions/withdrawals; portfolio and net-worth queries. | Reopening and direct contribution correction/removal have no conversation action. |
| Loans | Record lending, repayment, borrowing and paying back; show balances. | Direct loan-entry correction/deletion has no conversation action. |
| Bills and subscriptions | List, create, edit, pause/resume and remove Alfred's bill tracking. | Provider cancellation/payment and automatic bill creation from inferred purchases are unsupported. Renewal suggestions remain in the website. |
| Accounts and accounting | List/create financial accounts; edit labels/providers/cash inclusion. Captured-payment conversations classify payments and resolve supported own-account transfers. | Account currency changes/deletion are unsupported configuration actions. Manual balance snapshots, general transfer pairing, settlement management and accounting undo use Accounts. |
| People and notebook | Remember/forget a person's note; remember owner facts; ignore an account's bank texts. | Removing an owner note or reversing an ignored account uses Notebook. |
| Categorisation rules | Deterministic `/rule` commands list accounts/rules and review exact-merchant additions or disabling. | Natural-language future-rule requests receive command guidance; broader rule scope and account bindings use Settings. See [rule commands](account-rule-commands.md). |
| Profile, reminders and notifications | Read/patch supported profile fields, existing daily check-ins, payment mentions/push/preview, bill reminders and weekly overview preferences. | Authentication/Telegram bindings, device registration, browser permission and operational delivery setup use existing Settings/setup flows. Arbitrary reminders and new schedules are unsupported. |
| Data portability | No conversation import/export-management action. | Settings retains deterministic preview, explicit confirmation, receipts, guarded undo and Awaiting support. See [data portability](data-portability.md). |

There is a pre-existing confirmation gap in investment chat actions: adding or updating an investment, closing it, and recording contributions currently write directly in `lib/investments/actions.ts`. This change does not establish universal confirmation coverage. Category and budget writes use the explicit confirmation path; existing transaction auto-confirmation preferences and unrelated service behavior retain their current scope.

Existing budget updates still use the upstream upsert behavior: confirmation does not atomically compare the previously reviewed budget before replacing its amount. This remains a concurrency limitation of `set_budget`. The new combined category/first-budget action inserts only and rolls back if a budget appeared meanwhile; the new budget-removal action compares its reviewed snapshot atomically.

## Persistence and review

The forward migration is `supabase/migrations/20261105144649_custom_categories.sql`. It is required for persistent custom categories and must be applied separately after approval. No production migration or production data change is part of preparing this change for review.

The bill/account/preference management increment uses the existing reviewed tables and accounting writer; it adds no migration. Each service reports unavailable when its required existing storage or delivery setup is absent.

Exports include owner-scoped custom-category definitions in `alfred.native.customCategories` when category storage is installed. These definitions are preserved evidence, not automatically restored categories. After importing, recreate the categories manually in the destination to use them. Historical transaction and budget category strings remain in their existing exported records. Installations without category storage retain the existing export path; the optional category migration does not block their exports.

Review the migration and store implementation together for owner predicates, row-level policies, duplicate-name handling, category-name/type validation, and atomic category-plus-budget rollback. Confirm that unavailable schema fails without partial writes and that legacy storage does not pretend to support category creation.

## Validation

Verified the final PR state locally with Node.js 24.22.2 and fictional fixtures: all 204 test files / 2,406 tests passed with `npm test -- --maxWorkers=2`. Route type generation, typecheck and production build passed. ESLint passed with three pre-existing unused-variable warnings in unrelated tests. The archive suite passed 9 tests; the SQL suites passed 162 portability assertions, 170 export assertions across 37 migrations, and 58 capability assertions. The portability journey passed. Independent review also checked service ownership, confirmation grouping, timestamp precision and notification epochs. Earlier parallel runs hit five-second timeouts in existing SQL-heavy tests; the complete two-worker run passed without changing test timeouts.

Inspection found no category archive/unarchive implementation in either the base or this change. The instructions and negative action-contract test explicitly exclude it. Renaming and historical treatment remain separate and unanswered. Confirmation grouping also rejects multiple category writes rather than displaying two changes under one saved payload. These regressions are included in the final full-suite count.

The first sandboxed Turbopack build stalled during compilation and was interrupted. Running the same local build with expanded execution permissions completed successfully. No live-model evaluation was run; the screenshot-style conversation test uses a history-aware interpretation stub, so it verifies the application flow rather than real-model action selection.

The following review plan remains useful for extending this work:

Use fictional fixtures and ephemeral databases only. Record actual command outcomes in the change review; this document is a plan, not a claim that checks passed.

1. Exercise the multi-turn category-and-budget example and bill/account/preference actions, including missing details, confirmation, cancellation, expiry and unsupported storage. Test both shared web and Telegram paths.
2. Verify category visibility across owners and transaction types; duplicate names, built-in aliases, invalid names and unrecognised categories; and reuse in the existing transaction, budget, bank-label, report and rule paths.
3. Verify persistence with an ephemeral SQL database: category creation, idempotent name reuse, owner isolation, combined category/budget success, rollback when the budget write fails, missing-schema behavior, stale guarded budget deletion, precise bill snapshots, and partial preference updates. Check first notification opt-in, opt-out windows/epochs, readiness loss, and reminder review after a timezone change.
4. Run relevant conversation and UI regression suites, including `core`, `finance`, `turns`, `conversation`, `chat-follow-ups`, `open-question`, `honest-replies`, `model`, `category-combobox`, `account-rules-accounting-integration` and the new category/budget tests.
5. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and the portability archive, SQL and journey checks when persistence or portable category behavior changes. Report failures and environment limitations without applying a production migration to satisfy a check.

Publishing a review PR does not authorize merging, deploying or applying the category migration. Those operations require separate explicit approval.
