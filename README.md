# Alfred

Alfred is a personal finance app for the website and Telegram. A signed-in account can record expenses and income, review bank messages, manage budgets and savings goals, track investments and bills, and correct records. Both interfaces use the same owner-scoped stores.

**Settings → Data & privacy** downloads or imports a finance ZIP through deterministic validation, preview, explicit confirmation, receipts and guarded undo. Supported records populate the existing screens. Other source concepts remain recoverable in **Awaiting support**. Export/import does not invoke an AI model. See [data portability](docs/data-portability.md), [coverage](docs/portability-domain-matrix.md) and the [archive contract](docs/portability-format.md).

Account-specific category rules share one durable store between Settings and the bot. See [rule commands](docs/account-rule-commands.md).

## Local development

Use Node.js 22.12+ on the 22.x line, or Node.js 24.x, for the locked development tools:

```sh
npm ci
cp .env.example .env
npm run dev
```

Configure only the integrations you intend to use. Keep `.env` and credentials out of source control. The database connection is restricted to the Alfred project configured by the application; changing hosts requires an explicit code/configuration review.

## Configuration

`.env.example` describes the variables. The main groups are:

| Feature | Configuration |
| --- | --- |
| Server database | Supabase URL and server-only database password |
| Website sign-in | Public Supabase URL/key, server-only service-role key, Resend key and verified sender |
| New accounts | Invite list; existing accounts can continue signing in |
| Telegram | Bot token, webhook secret and an account-linked numeric Telegram ID |
| Conversational interpretation | Anthropic API key (`ANTHROPIC_API_KEY`); models default to Claude Haiku 5.5 and Sonnet 5.5 |
| Optional legacy Sheets storage | Google service-account email/private key and a shared spreadsheet |
| Defaults | Timezone, currency and transaction confirmation preference |
| Scheduled reminders | Cron bearer secret and separately configured schedules |

Server-only credentials must never use a `NEXT_PUBLIC_` prefix. Public Supabase keys are not service-role keys. Google service accounts should have access only to the intended spreadsheet.

`CONFIRM_TRANSACTIONS=auto` permits unambiguous new transaction records; ambiguous requests, corrections and deletions still require confirmation. `always` also confirms every new transaction.

## Database setup

Review the target and migrations before running:

```sh
npm run db:migrate
```

This command modifies the configured database and records applied filenames. Portability and account rules require the schema through the accounting migration, then the account-rule and data-portability migrations in filename order. Missing or incompatible schema makes these features unavailable without creating records. Previously applied draft schemas need a reviewed forward upgrade rather than a reused filename.

Keep imported source evidence and receipts when planning a rollback. Any rollback runtime must retain source hydration and notification pause guards after imports exist. Further setup and rollback requirements are in [data portability](docs/data-portability.md).

## Telegram setup

Create a bot through BotFather and configure its token and webhook secret. `/id` returns only the sender's numeric ID; save it in the website's Settings. The ID locks after its first private message.

On an HTTPS deployment, register the intended webhook:

```sh
npm run setup:webhook -- https://<your-domain>/api/telegram/webhook
```

The route validates the webhook secret and account before handling financial requests. A message cannot select another person's records or connection. Explicit `/rule` commands use deterministic parsing and their own scoped confirmation.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build
npm run test:portability:archive
npm run test:portability:sql
npm run test:portability:journey
```

Tests use fictional fixtures, mocks and ephemeral PGlite databases. They require no sibling repository, personal export, live database or bot. The journey exercises Alfred's actual accounting and normal screen stores against the archive contract; it does not run another app.

`npm run eval:labels` and `npm run eval:conversations` are separate conversational evaluation tools. Review their configured model/network behavior before invoking them.

## Deployment and operation

Deploy with a host that supports Next.js server routes, configure the intended environment variables, and apply reviewed database changes separately. Register the Telegram webhook only for the intended deployment. `GET /api/health` reports configuration-presence booleans without credential values.

A missing or invalid integration configuration fails closed. Importing historical finance records does not connect a bank, configure SMS forwarding, enable imported reminders or reuse another app's credentials. Reported balances remain source evidence; cash-flow totals are not invented bank balances.
