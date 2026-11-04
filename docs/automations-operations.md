# Alfred automations: operator setup

This is one server setup for all accounts. Users only connect their own Mac,
choose their updates and allow notifications on their devices. Settings does
not expose server keys, scheduler instructions or database diagnostics.

## Check the intended server environment

Run `npm run automations:check` in the deployment's already-loaded environment.
It checks signing-key format and pair validity, the delivery switch, and recovery
configuration. It prints statuses only; it does not load a local credential file,
create keys, contact a push provider, register a scheduler or change anything.

For an already authorized Alfred database connection, run
`npm run automations:check -- --database`. This adds catalog and operational
heartbeat reads. It does not read finance records or device subscription keys.
Exit 0 means the requested checks passed; without `--database`, database health
and scheduled execution remain unverified. Even a recent heartbeat is not proof
of scheduler registration or notification display on a device.

## Set up once

1. Deploy the reviewed application. Check the target's migration history and
   apply only reviewed pending migrations through the normal database workflow.
   Do not recreate a migration ledger over an existing schema or rerun completed SQL.
   The fee-notice follow-up requires `20261103235000_fee_notice_readiness.sql`
   before the matching application is enabled; the read-only catalog check
   includes that helper. Applying it changes notice policy, not financial data.
2. In the server's secret manager, supply Alfred's own `VAPID_PUBLIC_KEY`,
   `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`. Preserve an existing matching pair;
   copying Money's keys or rotating a working pair is not needed. Enable
   `ALFRED_PUSH_DELIVERY_ENABLED=true` only for the intended live deployment.
3. Register a recurring authenticated **POST** to
   `https://alfred.hansopoku.com/api/notifications/dispatch` every 60–300 seconds.
   Its header is `Authorization: Bearer <ALFRED_NOTIFICATION_CRON_SECRET>`.
   Store that secret privately and set `ALFRED_NOTIFICATION_SCHEDULES_ENABLED=true`,
   `ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID` to the actual registered job ID and
   `ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS` to its actual cadence.
   The caller must support authenticated POST and the route's 60-second budget.
4. Verify normal scheduled check-ins. Run the read-only check again. A missing,
   failed, stale or previous-configuration heartbeat keeps automatic delivery
   unavailable. Use the app's explicit test action on a consenting linked device
   to check transport; provider acceptance alone does not prove device display.

The existing daily reminders cron does not run the notification worker. A cron
entry added blindly to `vercel.json` is not a substitute: Vercel invokes GET,
and Hobby projects cannot deploy per-minute schedules. Choose an already
authorized compatible scheduler; this change does not register one or authorize
a hosting-plan purchase. [Vercel cron documentation](https://vercel.com/docs/cron-jobs)
and [limits](https://vercel.com/docs/cron-jobs/usage-and-pricing).

## Verify without changing financial history

Use synthetic/local integration fixtures before release. For production, inspect
normal authorized operation and a user-requested device test. Do not fabricate
SMS, replay old alerts or modify existing financial records to prove delivery.
Each user saves their own chat choices and device-push choice. Notification
permission and account consent are separate, and both remain under that user.

This local implementation has not provisioned or verified production keys,
registered scheduling, applied live SQL or demonstrated real device delivery.
