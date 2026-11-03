-- Draft policy transition only. Apply through the reviewed migration process;
-- this file does not send notifications or enable any preference/service.
-- Old code used future next_attempt_at as an untagged quiet-hours hold. Release
-- only eligible, never-attempted payment jobs. Do not shorten retry backoff,
-- touch ambiguous/accepted attempts, change scheduled bill/weekly events, or
-- revive a muted/old-epoch job. Existing attempted holds need metadata review
-- because the old schema did not distinguish quiet delay from retry delay.
update public.notification_deliveries d
set next_attempt_at=now(),last_result='immediate-payment-policy',updated_at=now()
from public.notification_preferences p
where d.owner_id=p.owner_id and d.kind='payment' and d.status='queued'
  and d.attempts=0 and d.attempted_at is null and d.last_result is null
  and d.next_attempt_at>now() and p.payment_push and d.preference_epoch=p.payment_epoch;
