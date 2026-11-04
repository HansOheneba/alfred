# Transfers and payment notifications in Chat

This change continues the notification flow in Chat. A canonical payment locator
opens `/chat?payment=<bank-message UUID>` and resolves the source only for the
signed-in owner. Older `/accounts?payment=...` links forward to the same Chat
entry instead of opening a classification modal. Opening a notification is a
read: it does not import, replay, classify, or duplicate a payment.

## Transfer matching

Automatic matching uses two observed source alerts, not an invented receiving
leg. Both must have the same positive principal and currency, opposite
directions, different owned cash accounts and timestamps within ten minutes.
The match must be unique in both directions. It additionally needs positive
own-transfer evidence, such as an established reference or the recognised
Hubtel withdrawal / MTN Credit.Inv payment rail. Equal amount and timing alone
are only a question for Chat.

Exact saved account assignments and explicit source bindings take precedence.
A provider can resolve an account only when its recognised alias identifies one
owned cash account in that currency; multiple accounts or conflicting suffixes
require clarification. User classifications, loans, refunds, holds, settlement
links and missing or changed source evidence must not be overwritten.

The owner-serialized ingest transaction stores both bank dispositions and the
accounting transfer link together, with source fingerprints, revision checks
and an audit event. The transferred principal is not ordinary income or
spending. Existing explicit fees remain separate, counted once. There is no
amount threshold or delay before an eligible alert can be announced. The first
alert can therefore ask a question before the matching second alert arrives;
opening Chat refreshes that question from current evidence.

Chat can confirm a proposed pair or undo an incorrect automatic match. A bare
yes answers only the exact saved question with unchanged evidence. Explicit
account names must identify unique saved accounts. Corrections recheck the
current pair, preserve later edits and fees, and remember the rejection so a
later alert does not silently recreate it. Naming accounts binds these observed
alerts; it does not create a blanket rule for every future provider message.

## Notification previews

`Show amounts in notifications` is an explicit account preference. Its default
is off, preserving existing private lock-screen previews. When enabled, only
validated amount, currency, direction and current owned paired-account labels
are eligible for financial copy. Raw SMS and payee descriptions are not copied
into push payloads. Reminder and test notifications remain nonfinancial.

Apply the reviewed pending migration
`20261104110000_notification_previews.sql` before deploying its matching
application. It adds the preference with a false default; it does not enable
push, change financial rows or provision a scheduler. Use the existing
[operator setup](automations-operations.md) for delivery activation.

## Verification limits

Local tests and previews use synthetic accounts and alerts. They do not prove
OS notification display, a live scheduler or production migration readiness.
The sample preview never reads Messages, subscribes a real device or sends a
push. Production account records and notification preferences are unchanged by
local review work.
