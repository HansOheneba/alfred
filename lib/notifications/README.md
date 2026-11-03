# Notification recovery contract

This code does not register a scheduler, generate credentials, or enable delivery.
Apply the reviewed notification migrations before using the API. All preferences
start off; private in-app payment mentions are independent of browser push.

## Immediate payment nudges

Opted-in payment nudges are eligible immediately, including overnight. They have
no intentional 22:00–07:00 hold. The device and operating system may still delay
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
