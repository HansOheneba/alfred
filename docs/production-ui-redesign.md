# Approved UI on authenticated routes

This change applies the reviewed Alfred design to the real application. `/ui-preview` remains a development-only reference and is not the application entry point. The production shell and route components do not import preview fixtures or preview stores.

| Approved change | Real application implementation |
| --- | --- |
| App navigation | Desktop retains the floating navigation. Mobile navigation is fixed flush to the bottom with safe-area padding. Chat, Overview, Accounts, Investments and Settings retain their actual routes. Chat has no top navigation; Settings retains profile and appearance access. |
| Remove Review and Notebook UI | Review keeps its existing redirect. Notebook/People UI and preview destinations are removed; legacy URLs redirect to Chat. Stored notes, people data and backend APIs are preserved. |
| Total account balance and contributing account count | `app/dashboard/account-balance.tsx` uses the existing accounting view and genuine snapshot times. Missing balances show an unavailable total rather than zero. Currencies remain separate; investments and loans are excluded. |
| Red Spent and green Income | `app/dashboard/overview-cards.tsx` and the shared stylesheet, including dark appearance. |
| Remove Kept and Daily average; present weekly spending differently | The summary contains only Spent, Income and the existing compact weekly comparison bars. |
| Reference-style monthly insights | Actual server-generated insights appear in stacked rows with teal accents, Refresh, and an Alfred bot button that changes into an input. Remaining insights can be expanded. |
| Ask about an insight | The input opens the real Chat route with a focused draft. It sends only after the user submits; there are no demo replies. Escape restores the button and focus. |
| Donut total and removal of empty category placeholder | The total appears in the center. Category detail and transaction filtering remain available after selection. |
| Improved income-to-spending flow | `app/dashboard/sankey-chart.tsx` presents the existing flow model as proportional source/pool/destination branches with keyboard inspection. It preserves comparison-gap and net-flow semantics. |
| Transaction dropdown spacing and timestamps | Labelled 44px controls with custom chevrons; desktop table and mobile cards remain. The current ledger contract provides dates only, so rows honestly say “Time not recorded.” No created-at or synthetic time is presented as an occurrence time. |
| Full-screen Chat | Chat fills the app viewport without a top bar, repeated branded header, boxed canvas or permanent side column. A concise headline, compact rounded composer and simple starter actions form the empty view. The same composer stays mounted when typing or starting a conversation, and sits below the thread once messages exist. Setup links stay inside Chat; financial context remains available on demand for populated accounts. Actual history, sends, attachments, retries, confirmations, charts and Telegram sync remain. Notebook, New message and the Chat composer privacy control are removed. |
| Conversation history | The existing saved conversation remains. The New message/reset control is removed from Chat; sending, retrying and typing behavior are unchanged. |
| Compact Accounts summary and Subscriptions tab | The existing real Accounts workspace keeps the inline currency control and Subscriptions uses the existing Bills component/API. Loading and error surfaces match the workspace. |
| Add a missing category for an incoming bill/payment | The bills shortcut opens Accounts → Needs attention. The existing movement category dialog supports persisted custom categories. Bill schedules themselves retain their existing schema. |
| Mobile spacing, keyboard and clearance | Shared 4px spacing, consistent type sizes and 44px controls. The message thread scrolls independently above its composer. Visual-viewport resizing accounts for keyboard occlusion; navigation is temporarily hidden while a mobile text keyboard occupies the viewport. Physical iOS keyboard behavior still needs device verification. |
| First-use screens | An empty financial history receives a Get Started checklist linked to the existing account editor, draft-only Chat and budget settings. Progress reflects saved records. Quiet periods, other currencies, existing financial data and unavailable storage remain distinct. Accounts/Investments show useful first-use guidance. |
| Settings refinements | The disconnected bank badge is removed, the account-name placeholder is generic, and Password opens an explicit editor with reveal, cancellation and status feedback. The existing password-update method and minimum length are unchanged. |
| Preserve other functionality | Budgets, goals, bills, loans, investments, settings and all existing transaction/account actions remain available. Bank-message balance facts remain accessible separately from account totals. |

## Scope

Changes are limited to UI components, UI route composition, readiness tests and documentation. API handlers, financial calculations, login/session boundaries, password-update contracts, schema and deployment/security settings are unchanged. No live database connection or migration was performed. Money handled for other people remains outside the requested work.

## Verification

- Full existing suite: 36 files, 381 tests passed, including isolated PGlite persistence tests.
- TypeScript passed.
- ESLint passed with one pre-existing unused `WELCOME_TEXT` warning in `tests/conversation.test.ts`.
- Production build passed for the combined UI. The earlier real-route authentication-boundary run used non-network public auth test configuration.
- Authentication handlers are unchanged. The earlier production-mode boundary run verified five signed-out redirects, four protected API denials and four disabled preview paths without external browser requests.
- Signed-in visual/state checks use private credential-free production builds with deterministic providers. Application sources are hash-compared; test auth/data providers are never shipped. Coverage includes first-use and populated views, mobile/desktop navigation, scrolling, simulated keyboard/safe areas, Chat callbacks, legacy redirects and the password editor. The development preview is checked separately. These checks verify UI behavior, not live authentication, persistence or hosting rollout.

## Release status

A production build is not a production deployment. This branch requires review/merge and the existing hosting workflow before the redesign is live. The previously deferred Vercel access block is unchanged. No PR merge, manual deployment, access expansion or database migration is part of this delivery.
