# Account-specific categorisation rules

Settings and the bot use one owner-scoped rule store. Matching is deterministic: Unicode-normalized, trimmed, whitespace-collapsed, case-insensitive exact merchant text, with explicit account and direction. Manual category edits take precedence. Rules change categorisation, not payment confirmation status or source text.

## Settings

Open **Settings → Categorisation rules** to inspect, create, edit, disable or enable rules. A rule covering every merchant still belongs to one selected account and requires an additional scope acknowledgement.

Future SMS account recognition uses an explicit provider + account suffix + currency binding. A provider name alone never identifies one of your accounts. Importing history does not configure SMS forwarding.

## Bot commands

Telegram private chat and signed-in web chat accept these fixed commands without invoking the language model:

```text
/rule help
/rule accounts
/rule list
/rule list <account-id>
/rule add <account-id> "exact merchant text" "Category" [out|in|any]
/rule disable <rule-id>
/rule confirm <token>
/rule cancel <token>
```

Use `/rule accounts` to obtain an account ID. Merchant and category values must be double-quoted JSON strings. Direction defaults to `out`; `in` covers receipts and `any` covers both directions for that same account and exact merchant.

Adding or disabling a rule first creates a ten-minute review. The reply identifies the account, merchant, direction and category, including any existing rule being replaced. Confirm with the supplied token from the same owner and original chat. Generic “yes” and ordinary finance confirmation buttons do not confirm a rule command.

A new rule starts at confirmation time. Stale account identity or rule revisions require a new review. Repeated confirmation uses a durable request identity and cannot add another rule. If a reply is uncertain, retry the same token and inspect `/rule list`.

Natural requests for future account categorisation receive command guidance rather than becoming an opaque Notebook note. Bot commands support exact merchants; broader scope and account bindings use Settings. Read-only bot lists show bounded previews and point to Settings for the complete list.

Numeric account endings, merchant names and effective dates do not bypass that guidance. A clear leading expense or income clause with an amount, such as “add 20 from my momo wallet to the food category, I always buy lunch”, follows the usual transaction interpretation and confirmation flow. It does not create a standing rule. Explicit `/rule` commands are handled before this natural-language routing and can use numeric account IDs and quoted merchant names normally.

## Setup and behavior

The baseline accounting and account-rule migrations must be available before rule writes. Apply the reviewed forward `20261102190000_portability_review_fixes.sql` migration after the unchanged published `1700`/`1800` files for the combined portability release; do not install these fixes by modifying a previously applied migration. Missing or incompatible rule storage fails without creating a rule. A positive rule-readiness check is cached briefly per database identity and capability; negative checks are retried immediately so completed setup is visible on the next request. Rules project categories when accounting history/reports load. They do not bypass the existing Bank messages review flow or replace older global payee-filing rules.

Imported rules activate only when account references map unambiguously. Their source order, direction and effective date remain intact. Unmapped conditions stay recoverable in Awaiting support.

Tests cover parser boundaries, owner/chat isolation, expiry/cancel, explicit review, concurrent and repeated confirmation, uncertain-write recovery, app/bot shared persistence, exact matching, status preservation and manual precedence. All fixtures and databases are synthetic.
