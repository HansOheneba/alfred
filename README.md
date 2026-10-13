# Alfred

Alfred is a personal finance assistant for Telegram and the website. A signed-in user can log expenses and income, ask for summaries, set budgets, track savings goals, and correct or delete records. Both interfaces use the same ledger.

Telegram access comes from the Telegram ID saved on that user's account. The ID can be edited in Settings until the first private message arrives from it. After that message, the ID is locked.

Website sign-in emails a one-time code through Resend. A password is optional and can be added later in Settings.

## How a message is handled

Telegram sends an update to `POST /api/telegram/webhook`. The route checks the webhook secret, validates the payload, and confirms the sender's numeric Telegram user id. Only then does it call DeepSeek or Google Sheets. DeepSeek proposes a structured action. The server validates that action, calculates totals itself, and writes to the spreadsheet. The bot replies only after the required write has been checked.

A message cannot choose a spreadsheet or another person's records.

## Requirements

- Node.js 20.9 or newer
- A Telegram bot from [@BotFather](https://t.me/BotFather)
- A DeepSeek API key
- A Google Cloud service account and one spreadsheet shared with that account
- A Vercel project, or any host that can run Next.js server routes over HTTPS

## Environment variables

Copy `.env.example` to `.env`. Do not commit `.env`. None of these variables use a `NEXT_PUBLIC_` prefix.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | 16–256 characters: letters, numbers, `_`, `-`. Generate with `openssl rand -hex 32` |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `DEEPSEEK_MODEL` | `deepseek-flash` or `deepseek-v4-pro` |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Service account email |
| `GOOGLE_PRIVATE_KEY` | PEM private key. In Vercel, store newlines as `\n` |
| `GOOGLE_SHEETS_SPREADSHEET_ID` | Id from the spreadsheet URL |
| `AUTHORIZED_TELEGRAM_USER_IDS` | Optional fallback only when Supabase is not configured |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL used by the browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key. Never put the service-role key here |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only key for seeding accounts and creating sign-in codes |
| `RESEND_API_KEY` | Resend API key used to email sign-in codes |
| `RESEND_FROM_EMAIL` | Verified From address, such as `Alfred <alfred@example.com>` |
| `CRON_SECRET` | Bearer token for `GET /api/cron/reminders` |
| `APP_TIMEZONE` | Default `Africa/Accra` |
| `DEFAULT_CURRENCY` | Default `GHS` |
| `CONFIRM_TRANSACTIONS` | `auto` or `always` |

`auto` records an unambiguous expense or income immediately. Ambiguous messages, corrections, and deletions still ask for confirmation. `always` asks before every new transaction too.

The model ids were checked against the DeepSeek models list on 11 Oct 2026. `deepseek-flash` and `deepseek-v4-pro` are the current ids. A live JSON-mode call to `deepseek-flash` with thinking disabled succeeded. Google Sheets writes have not been run against a real spreadsheet in this environment because those credentials are not configured yet.

## Google Cloud and Sheets

1. In Google Cloud, create or choose a project.
2. Enable the Google Sheets API.
3. Create a service account. Do not give it project-wide editor access.
4. Create a JSON key and copy the client email and private key into the environment variables.
5. Create a spreadsheet for Alfred only.
6. Share that spreadsheet with the service account email as an Editor. Do not share the rest of Drive.
7. The Sheets scope used by the app is `https://www.googleapis.com/auth/spreadsheets`. The service account can only open files that were shared with it.

Prepare the tabs without touching existing rows:

```bash
npm run setup:sheets
```

The script creates these tabs if they are missing and writes a header row only when row 1 is empty. If the headers do not match, it stops and leaves the rows alone.

### Transactions

`transaction_id`, `created_at`, `transaction_date`, `user_id`, `type`, `amount`, `currency`, `category`, `description`, `payment_method`, `notes`, `status`, `updated_at`, `source_update_id`

`source_update_id` is an extra column used to recognize a Telegram retry. Amounts are positive decimals. `type` is `income` or `expense`. `status` is `active` or `deleted`. Deleted rows stay in the sheet and are left out of totals. `created_at` and `updated_at` are UTC ISO timestamps. `transaction_date` is a date in the user's timezone.

### Budgets

`budget_id`, `user_id`, `period`, `category`, `amount`, `currency`, `created_at`, `updated_at`

`period` is `YYYY-MM`. Remaining budget is the budget amount minus active expenses in that category, currency, and month. If spending is higher, the bot says how far over it is.

### SavingsGoals

`goal_id`, `user_id`, `name`, `target_amount`, `current_amount`, `currency`, `target_date`, `status`, `created_at`, `updated_at`

A goal is recorded progress. It is not a bank balance. Logging a savings-goal contribution does not also create an expense unless the user explicitly records that expense too.

### ProcessedUpdates

`update_id`, `user_id`, `status`, `result_reference`, `processed_at`

Telegram may deliver the same update more than once. Alfred stores the update id and replays the previous reply instead of writing a second transaction. This is not a database transaction. Two overlapping requests can both pass the first read; the earliest processing row continues, and transaction rows also carry `source_update_id` so a retry can find a write that already landed. If you need strict uniqueness under concurrent writes, move this state to a database.

### PendingActions

`action_id`, `user_id`, `chat_id`, `action_type`, `payload_json`, `status`, `expires_at`, `created_at`

Corrections and deletions, and transactions that are not explicit enough, create a pending action for 15 minutes. The user confirms with inline buttons. The action is bound to the user id and chat id. Another user cannot confirm it. The payload is validated again before it runs. Expired actions do nothing.

## Telegram

1. In BotFather, create a bot and copy the token.
2. Before you register a webhook, send `/id` to the bot or run:

```bash
npm run telegram:user-ids
```

`/id` replies with the sender's numeric id and no financial data. It works even when that id is not authorized yet. `getUpdates` returns nothing after a webhook is set; delete the webhook first if you use the script.

3. Sign in on the website and save that numeric id in Settings. Usernames are not accepted. The id locks after the first private message from it.
4. Deploy the app so `https://<your-domain>/api/telegram/webhook` is public HTTPS.
5. Register the webhook:

```bash
npm run setup:webhook -- https://<your-domain>/api/telegram/webhook
```

That calls `setWebhook` with the URL, `secret_token`, and `allowed_updates` set to `message` and `callback_query`.

The current bot username from `getMe` is `@MadeByTonyBot`. The production webhook path is always `/api/telegram/webhook` on the deployed HTTPS origin.

## Local development

```bash
npm install
npm run dev
```

Useful checks:

```bash
npm test
npm run lint
npm run typecheck
npm run build
npx tsx scripts/smoke-interpret.ts
```

`smoke-interpret.ts` sends one example sentence to DeepSeek and prints the validated action. It does not write to Google Sheets.

## Deploy on Vercel

1. Import the Git repository.
2. Add every variable from `.env.example` in the project settings. Paste the private key as one line with `\n` for newlines.
3. Deploy.
4. Set the function timeout to at least 60 seconds if the plan allows it. The webhook route sets `maxDuration` to 60.
5. Run `npm run setup:sheets` locally with the production spreadsheet credentials, then `npm run setup:webhook` with the production URL.

Health check: `GET /api/health` returns `{ "status": "ok", "checks": { ... } }`. The booleans say whether a variable is present. They do not return the values.

## What you can say

Weeks start on Monday and end on Sunday, in `Africa/Accra` unless `APP_TIMEZONE` changes. A missing period is treated as this calendar month, and the reply shows the dates. Totals are recorded cash flow, not an account balance.

Examples:

- I spent GH₵45 on lunch
- I received GH₵500 salary
- How much have I spent this week?
- How much did I spend on food this month?
- What is my total income this month?
- How much did I save?
- Set my food budget to GH₵1,200 this month
- How much of my food budget remains?
- Show my biggest expenses this month
- Compare this month with last month
- Give me a financial summary for September
- Change the lunch expense to GH₵55
- Delete the duplicate transaction
- Undo my last expense

Several expenses in one message are checked first, then written one by one. If one write fails, the reply lists what was recorded and what failed.

Initial expense categories: Food, Transport, Utilities, Subscriptions, Savings, Emergencies, People, Personal, Social, Misc. Income categories: Salary, Business, Gift, Refund, Other. Unknown categories are questioned rather than invented. Lunch maps to Food. Trotro maps to Transport.

## Change the user or spreadsheet

1. Change the Telegram ID in Settings before the first message locks it. After it locks, that ID stays on the account.
2. To use another spreadsheet, share it with the same service account, set `GOOGLE_SHEETS_SPREADSHEET_ID`, run `npm run setup:sheets`, and redeploy.
3. Several authorized ids can share one spreadsheet. Rows are filtered by `user_id`, so they do not see each other's totals. A later user directory can map each Telegram id to its own spreadsheet id inside `authorizeUser` without letting a message pick the sheet.

## Smoke test

- [ ] `GET /api/health` returns `status: ok` and no secrets
- [ ] A request without the webhook secret returns 401
- [ ] `/id` returns only the numeric user id
- [ ] A Telegram id that is not saved on an account gets the linking message. `/id` still returns only the numeric id.
- [ ] "I spent GH₵45 on lunch" creates one Transactions row and the bot confirms the amount, category, description, and date
- [ ] Sending the same update again does not create a second row
- [ ] "How much have I spent this week?" matches the active rows for Monday–Sunday
- [ ] "Delete the duplicate" or "Undo my last expense" asks for the inline buttons before changing anything
- [ ] A deleted row remains in the sheet with status `deleted` and drops out of the next total

## Troubleshooting

- **401 from the webhook.** The `X-Telegram-Bot-Api-Secret-Token` header does not match `TELEGRAM_WEBHOOK_SECRET`. Register the webhook again after changing the secret.
- **500 before any reply.** A required Telegram variable is missing or the webhook secret is shorter than 16 characters or contains unsupported characters.
- **The account isn't linked.** The numeric id is not saved in Settings. Use `/id`, save it on the website, then message again. After the first message, the ID can no longer be edited.
- **"Finance storage is not configured yet."** The three Google variables are incomplete.
- **Spreadsheet permission error.** Share the spreadsheet with the service account email as Editor and confirm the Sheets API is enabled.
- **Header mismatch.** The first row was edited by hand. Restore the headers listed above or use a new tab. The setup script will not overwrite data rows.
- **DeepSeek busy or slow.** The bot asks you to retry. It does not guess a transaction when the model output fails validation.
- **Duplicate confirmation messages.** Telegram retried an update after the reply was stored. The transaction row should still be unique. Check `source_update_id` before entering it again by hand.
- **The bot never replies and `getUpdates` is empty.** A webhook is already set. Use the webhook route, or delete the webhook before using `npm run telegram:user-ids`.

## Limits

- Photos, voice notes, and files are ignored.
- Google Sheets does not provide unique constraints or multi-row transactions. Deduplication is tested for sequential retries and is best-effort if two requests overlap.
- The per-user rate limit of 20 messages a minute lives in the server process, so it is not shared across every Vercel instance.
- The whole sheet is read on each financial request. That is appropriate for one person's records, not for a large multi-user ledger.
- Alfred never reports a bank balance from these rows.
