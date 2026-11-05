# Notification recovery contract

## Message visibility (local review draft)

The message-notification changes are prepared locally for review. Nothing in this
work registers a device or scheduler, changes a live preference, sends a test or
replay, or applies a database migration.

Authenticated pages show an owner-scoped unread badge on Chat and a discreet
“Alfred sent you a message” alert while another Alfred section is open. Realtime
updates have a bounded polling fallback. Counts contain no message text or
financial copy. A message is marked read only after the actual Chat thread is
loaded, focused, visible and following its latest messages. Loading shells,
hidden tabs and a thread scrolled away from the bottom do not mark it read.
Presence leases are per browser tab and expire after 30 seconds; a hidden tab
cannot clear another visible tab’s lease. Metadata polling that discovers a
message missing from the rendered thread withholds its visible lease and asks
the owned thread to refresh, at most once per 15 seconds for that message. Failed
thread reads stay inactive. The server also refuses to renew a visible lease for
an older assistant marker while a newer owned assistant message exists.

Device delivery for ordinary Alfred replies uses a separate **Messages from
Alfred** opt-in. It defaults off. Its separate **Show message previews** consent
also defaults off and warns that lock screens can show financial message text.
Without that consent, the payload remains generic. Previews are bounded plain
text, never arbitrary links or notification actions. Tapping opens Chat; replies
from the notification are not implemented. Existing payment previews keep their
separate setting.

Only durable owned assistant messages created after both opt-in and device
activation are eligible. Read messages and visible Chat suppress message pushes.
Recovered bank Chat notices also require the underlying bank source to be newer
than message opt-in and device activation; card activity additionally respects
its rollout cutoff. A new Chat row cannot make a historical bank alert eligible.
The outbox stores opaque source IDs, not message text. Ownership, consent epoch,
device validity, source readiness, read state and latest preview consent are
checked again before a provider call. Eligible or already attempted bank-payment
notifications cover their matching Chat notice, avoiding a second generic
message push. Unknown connection outcomes remain terminal `unconfirmed` and are
not automatically sent again.

The authenticated dispatcher recovers missed message work independently of page
visits. Web replies and bank Chat notices also make a bounded post-response
delivery attempt. Provider acceptance still does not prove device display.
Visible-Chat leases, scheduler cadence, OS settings and provider delays mean this
is best effort, not an instantaneous-delivery promise.

After review and publication approval, prepare the database in this order:

1. `20261105093000_card_activity_push.sql` establishes the new card-activity
   rollout cutoff. Existing payment opt-ins are unchanged; historical holds are
   not replayed. Hold previews explicitly say “Card hold” or “Card settlement
   alert”. Older workers fall back to discreet copy.
2. `20261105100000_message_notifications.sql` creates the separate preference,
   read/presence and message-outbox tables. Client roles cannot read device keys
   or mutate those tables directly.

These migrations have **not** been applied by this local work. Deploy matching
application code only with the reviewed schema. Actual iPhone/background delivery
and OS lock-screen presentation still need authorized device verification.

For an application rollback, restore the prior reviewed code and retain the
additive schema and delivery history. Dropping or resetting delivery rows would
erase deduplication and ambiguous-send evidence. A later rollout must preserve
the original source cutoffs and terminal attempted/accepted/unconfirmed history;
it must not reset opt-ins or replay old alerts. No rollback has been executed.

This code does not register a scheduler, generate credentials, or enable delivery.
Apply the reviewed notification migrations before using the API. All preferences
start off; private in-app payment mentions are independent of browser push.

## Payment previews and chat entry

Existing users keep discreet notification copy. **Show amounts in notifications**
is a separate account preference, off by default, and explicitly warns that the
lock screen can show financial amounts and linked account names. Apply the
reviewed `20261104110000_notification_previews.sql` migration before deploying
the matching application; it only adds the off-by-default preference.

Payment jobs store source locators rather than pre-rendered financial copy.
After claiming a job the server reloads the exact owned source and then the latest
preview preference. Only opt-in previews contain validated amount, currency and
direction fields. Raw SMS, counterparties and arbitrary body text are excluded.
Current, durably paired own-account transfers can include the two bound account
labels and share the outgoing source's notification tag. An earlier first-leg
notice may already have appeared; pairing never deliberately delays either leg.
Turning previews off changes future sends, including queued work; it cannot
withdraw a notification already displayed by an operating system.

Both declarative Web Push and the push-only service worker format the same
structured data. Old payloads remain discreet and reminders/tests never contain
payment previews. The worker accepts only a canonical payment UUID and opens
`/chat?payment=<UUID>` on Alfred's own origin, where authentication and source
ownership are checked again. Notifications contain no financial data in their
click-target metadata. The worker does not cache authenticated pages or financial
responses and activates updates without waiting for existing tabs to close.

## Immediate payment nudges

Opted-in payment nudges are eligible when the alert arrives, at every local
hour and for every positive amount, including 0.50. There is no amount-based
settling delay and an unnamed debit does not wait for another payment alert.
A debit already confirmed as a fee-only record does not produce a separate
principal notice. If its SMS arrives before the related payment, it can produce
a purpose question immediately. Later fee linking can leave that earlier
question outdated; current source state is rechecked before an answer can label
it again. That trade-off preserves immediate announcements without guessing.
There is no intentional 22:00–07:00 hold. The device and operating system may still delay
or silence display, and a provider response is not proof of lock-screen display.
Bill reminders retain their 09:00 local window and weekly notices retain their
Sunday 18:00 local window; their separate preferences are unchanged.

The authenticated dispatcher also discovers due queued owners without a new SMS,
page visit, or unrelated activity. Opted-in payment work is not discarded merely
because its original alert is over 24 hours old. Original opt-in and device
activation cutoffs still exclude history. Muting or changing the preference
epoch cancels queued work atomically. Current classification, device expiry,
and ownership are rechecked before claiming a send.

The draft `20261103220000_immediate_payment_nudges.sql` migration releases only queued, never-attempted
payment jobs with no previous result, leaving retry/backoff and nonpayment
schedules unchanged. The old implementation did not tag quiet deferral separately
from retry deferral. Already-attempted legacy holds therefore need metadata review
rather than a blind reset that could shorten retry backoff. The migration does
not send anything, enable preferences, or revive accepted/unconfirmed/muted work.

There is no silent age-based expiry for an eligible queued payment notice.
Provider acceptance, definite rejection after bounded attempts, ambiguous
connection outcomes, opt-out and device removal retain their existing terminal
semantics. A connection outcome that could already have delivered remains
`unconfirmed` and is not automatically retried.

## Recovery readiness

Enabling device-push preferences through the API requires configured push
transport, the delivery switch, and `recoveryReady=true`. The latter requires:

- `ALFRED_NOTIFICATION_SCHEDULES_ENABLED=true`;
- an existing `ALFRED_NOTIFICATION_CRON_SECRET`;
- explicit operator registration metadata in
  `ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID`;
- `ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS` between 60 and 300 seconds;
- a successful completed authenticated dispatcher check-in, bound to that
  configuration, within twice the expected interval (at least five minutes).

The authenticated POST dispatcher records completion only after both chat-mention
recovery and notification dispatch succeed. A failure in either task invalidates
readiness, including when an earlier completed heartbeat was still recent. A
mention-recovery failure returns an error before notification dispatch and retains
work for a later healthy run. The first bootstrap dispatch
establishes health; a later scheduled run can deliver retained work if no recent
successful heartbeat was available before bootstrap. A stale/missing heartbeat
pauses sends and prevents new device-push opt-ins; it does not cancel queued
payments or disable private in-app mentions.

An operator-supplied schedule ID and a recent check-in do **not** independently
prove a scheduler is registered or guarantee its future availability. The UI
therefore reports a recent check-in rather than verified automatic delivery.
Production schedule registration, cadence, platform execution limits and actual
browser delivery must be validated separately after authorization. No such
production validation or registration has occurred in this local work.

The dispatcher uses bounded batches and fair owner paging. Its configured
cadence and capacity must be sufficient to drain those batches. End-to-end push
remains best-effort; immediate eligibility does not promise instantaneous receipt.
