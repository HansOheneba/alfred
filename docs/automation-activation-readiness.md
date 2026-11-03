# Automation activation handoff

This is preparation for an operator-approved release, not evidence that live
collection or notifications are running. Hans owns merge and deployment. The
eight drafts, secret configuration, scheduler registration, Mac permissions and
device consent have not been applied or activated by this handoff.

## Confirm the target before any change

The runtime fixes Alfred's database project and ingestion destination in
`lib/config.ts` and the collector transport. Use only that existing production
project through its normal authorized connection. Do not copy Money Dashboard
credentials, create another project, broaden access, inspect SMS bodies, or
change existing financial records. The publication checkout contains only
`.env.example`; its presence does not establish production configuration.

`automation-activation-preflight.sql` contains catalog and migration-ledger reads
only. Have the authorized database operator run it in a read-only transaction.
Compare its results against the current merged checkout before approving writes.
A missing ledger or a schema/ledger mismatch is a stop condition, not permission
to recreate the ledger or rerun files. Retain only migration names and catalog
results in the review; never include credentials or notification subscriptions.

## Review exactly eight new migrations

1. `20261103110000_notifications.sql`
2. `20261103113000_bank_notice_receipts.sql`
3. `20261103150000_collector_event_receipts.sql`
4. `20261103200000_notification_recovery.sql`
5. `20261103210000_collector_health.sql`
6. `20261103220000_immediate_payment_nudges.sql`
7. `20261103230000_collector_health_removal.sql`
8. `20261103233000_payment_activity_notices.sql`

The first five add operational schema and functions. The sixth adjusts only
eligible queued, never-attempted payment-notification jobs with the current
enabled preference epoch; it does not rewrite finance records or send anything.
Review counts of affected queue metadata before applying it. Never reset
already-attempted or ambiguous delivery rows just to make them eligible sooner.
The seventh adds an owner-scoped function for removing a saved Mac status entry.
It does not stop collection, revoke a forwarding key, delete saved alerts or
change financial records. An active Mac can report its status again.
The eighth adds a separate, off-by-default outgoing-announcement choice and the
v2 atomic activity-notice writer. Existing incoming consent is unchanged. It
does not announce imported history or create additional financial transactions.

`npm run db:migrate` is **not** an eight-file-only, atomic activation command: it
applies every pending file and records each ledger row in a separate query.
Some drafts create triggers and cannot be blindly rerun. Use the established
database release workflow with a reviewed pending-file plan, a single checked
transaction on one database connection for the selected batch and its ledger
rows, and a rollback plan. The current pooled `query()` helper cannot guarantee
the same connection for separately issued BEGIN/COMMIT calls.

Before approving the actual application, verify the complete earlier baseline is
already recorded and that these eight files are either all missing or have an
understood, consistent partial state. Applying a fresh all-eight batch must commit
the schema and matching ledger rows together. Retrying must skip files already
recorded rather than re-execute them. This document deliberately supplies no live
write command until the actual ledger and target have been reviewed.

The local rehearsal is `node tests/notification-activation-sql.integration.mjs`.
It creates an in-memory PostgreSQL database, rehearses failure rollback and a
successful eight-file commit, and verifies off-by-default preferences, client
restrictions and absence of financial writes. It never loads `.env`, registers
a scheduler, contacts Alfred or uses a real account.

## Configure notification recovery before opt-in

Supply Alfred's own `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` and
`ALFRED_NOTIFICATION_CRON_SECRET` through the normal secret-management process.
Do not generate or disclose them in chat. A new forwarding key or signing
identity is a separate credential action, not implied by preparing code.

Register a scheduler that sends an authenticated **POST** to
`/api/notifications/dispatch` every 60–300 seconds. Its Authorization header is
the private bearer cron secret. Record its actual registered identifier and
interval in `ALFRED_NOTIFICATION_RECOVERY_SCHEDULE_ID` and
`ALFRED_NOTIFICATION_RECOVERY_INTERVAL_SECONDS`, and explicitly enable
`ALFRED_NOTIFICATION_SCHEDULES_ENABLED`. The existing daily reminder cron is
not this recovery schedule. A GET-only cron or Codex's hourly personal tasks do
not meet the contract. Do not invent registration metadata in place of a real
schedule or select a paid service without approval.

Delivery additionally needs `ALFRED_PUSH_DELIVERY_ENABLED=true`. Keep user
preferences off during initial setup. The first authenticated completed
dispatcher call establishes health; its ordinary work can recover eligible
existing notices, so it is a live operation requiring approval. Verify cadence
over multiple normal runs, then allow the account and browser to opt in. A
recent check-in is evidence of a completed call, not proof of permanent schedule
availability or device display.
The completed heartbeat covers both chat-mention recovery and notification
dispatch. If either task fails, the run returns an error and records failed
health; a partial run cannot keep new push opt-ins available. Queued work stays
for a later successful run.

After the feature is merged and deployed, the signed-in page's GET
`/api/notifications` reports safe configuration flags, preference/device
metadata and a recovery reason: `not-configured`, `schema-unavailable`,
`never-completed`, `configuration-changed`, `failed`, `stale` or `ready`.
The response excludes private keys and subscription endpoints. Its ordinary
account lookup can create missing empty account companion rows. No preference,
subscription, notification or financial transaction is created by the settings
lookup itself. Do not treat a generic 503 as proof of a particular missing table.

## Install and connect the Mac separately

Confirm the app's supported architecture/minimum OS and a stable signed,
notarized distribution build before calling it a general-user release. Review
the static sandbox and Messages database/WAL/SHM read-only scope on the target
OS. Full Disk Access is a distinct user-granted permission; neither a build nor
an entitlement inspection proves real access. Never replace the launcher or
broaden entitlements to route around a denial.

An installation can copy an inactive app; it must not launch, grant permissions,
register autostart, connect an account or start collection as a side effect.
Account configuration requires the intended Alfred forwarding key privately,
the explicit selected provider subset, and confirmation of the displayed name
and email. Then obtain action-time permission for future-only initialization,
service activation and actual forwarding. Keep Money Dashboard's installed
collector and state unchanged.

Verify actual processing with one naturally arriving eligible alert only after
authorization. Distinguish successful Mac access, local capture, durable Alfred
acknowledgement, new financial records and device display; they are separate
results. Do not fabricate a bank SMS or send a real push merely to turn a check
green. Keep raw text, amounts, keys, sender details and personal payloads out of
test reports.

## Current blockers

- PR #26 was merged on 3 November. The Money-style native setup and outgoing
  chat-announcement follow-up remain local pending review/publication. The new
  Mac setup checks `setupProtocol: 1` and `setupReady: true` from the existing-key
  identity endpoint before reading Messages or enabling background operation.
  These flags come from an actual catalog read, not an environment assertion;
  device-push configuration is separate. An older endpoint or missing schema
  keeps automatic collection off.
- No authorized production database catalog/ledger result is available in this
  local checkout. Live migration state remains unverified.
- Production secret configuration, actual recovery schedule registration,
  stable distribution identity/notarization, Mac permission grants and real
  delivery are separate operator/user actions still awaiting review.
