# Approved UI on authenticated routes

This change applies the reviewed Alfred design to the real application. `/ui-preview` remains a development-only reference and is not the application entry point. The production shell and route components do not import preview fixtures or preview stores.

| Approved change | Real application implementation |
| --- | --- |
| Floating bottom navigation on desktop and mobile | `app/components/app-shell.tsx` and `app-ui.css`; Chat, Overview, Accounts, Investments and Settings retain their actual routes. The profile, privacy and appearance controls remain available. |
| Remove Review; integrate Notebook into Chat | Existing Review/Notebook redirects remain. The Notebook tool opens the existing saved notebook inside Chat. |
| Total account balance and contributing account count | `app/dashboard/account-balance.tsx` uses the existing accounting view and genuine snapshot times. Missing balances show an unavailable total rather than zero. Currencies remain separate; investments and loans are excluded. |
| Red Spent and green Income | `app/dashboard/overview-cards.tsx` and the shared stylesheet, including dark appearance. |
| Remove Kept and Daily average; present weekly spending differently | The summary contains only Spent, Income and the existing compact weekly comparison bars. |
| Reference-style monthly insights | Actual server-generated insights appear in stacked rows with teal accents, Refresh, and an Alfred bot button that changes into an input. Remaining insights can be expanded. |
| Ask about an insight | The input opens the real Chat route with a focused draft. It sends only after the user submits; there are no demo replies. Escape restores the button and focus. |
| Donut total and removal of empty category placeholder | The total appears in the center. Category detail and transaction filtering remain available after selection. |
| Improved income-to-spending flow | `app/dashboard/sankey-chart.tsx` presents the existing flow model as proportional source/pool/destination branches with keyboard inspection. It preserves comparison-gap and net-flow semantics. |
| Transaction dropdown spacing and timestamps | Labelled 44px controls with custom chevrons; desktop table and mobile cards remain. The current ledger contract provides dates only, so rows honestly say “Time not recorded.” No created-at or synthetic time is presented as an occurrence time. |
| Redesigned Chat and compact mobile header | Actual history, sends, image attachment, retries, confirmations, charts and Telegram sync remain. Desktop context cards become a focus-managed sheet on mobile. The three mobile tools are 44px targets. Included account balances use the genuine accounting view; bank-message facts stay separately expandable. |
| New conversation control | The actual contract provides one saved conversation. “New message” clears the draft and focuses the composer while preserving history. It does not call the destructive history deletion endpoint. |
| Compact Accounts summary and Subscriptions tab | The existing real Accounts workspace keeps the inline currency control and Subscriptions uses the existing Bills component/API. Loading and error surfaces match the workspace. |
| Add a missing category for an incoming bill/payment | The bills shortcut opens Accounts → Needs attention. The existing movement category dialog supports persisted custom categories. Bill schedules themselves retain their existing schema. |
| Mobile spacing, typography and clearance | Shared 4px spacing scale, consistent type sizes, 44px interactive controls and reserved space for the floating navigation; the Chat thread scrolls above its composer. |
| Preserve other functionality | Budgets, goals, bills, loans, investments, settings and all existing transaction/account actions remain available. Bank-message balance facts remain accessible separately from account totals. |

## Scope

Only application UI sources and this checklist change. There are no API, accounting engine, database schema, migration, authentication, deployment setting or security changes. No migration was inspected or applied for this UI-only request. Money handled for other people remains outside the requested work.

## Verification

- Full existing suite: 35 files, 376 tests passed, including the optional isolated PGlite persistence tests.
- TypeScript passed.
- ESLint passed with one pre-existing unused `WELCOME_TEXT` warning in `tests/conversation.test.ts`.
- Production build passed, including with local non-network public auth test configuration.
- Actual production server: all five protected routes redirected a signed-out browser to Sign in; accounting/chat/settings/notebook requests returned 401. All four tested preview paths returned 404. No external browser request occurred.
- Signed-in visual/state verification uses a private production-mode test copy with deterministic provider/API fixtures and no credentials. UI sources are hash-compared with this branch; the fixture providers and auth setup are never shipped. This verifies rendering and interactions, not live database persistence or hosting rollout. All 61 browser checks passed: the five real routes at 320/390/768/1456px, light/dark appearance, navigation/overflow/dock clearance, loading/empty/error states, insights focus and draft handoff, Chat send/retry/confirmation/attachment callbacks, Notebook/context focus, account controls, and known/missing/unavailable balance states. There were no unhandled browser errors or external origins. All 74 tested application TSX/CSS files matched source hashes (the private auth provider is excluded).

## Release status

A production build is not a production deployment. This branch requires review/merge and the existing hosting workflow before the redesign is live. The previously deferred Vercel access block is unchanged. No PR merge, manual deployment, access expansion or database migration is part of this delivery.
