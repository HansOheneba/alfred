# Release checklist for Hans

1. Apply these pending migrations, in order, through Alfred's existing database
   release workflow before deploying the matching application:
   - `20261104160000_explicit_payment_resolutions.sql`
   - `20261104170000_import_provider_summaries.sql`
2. Prepare summaries for existing active import receipts using the bounded
   [summary setup query](import-provider-summary-activation.md). New imports
   create their summaries automatically. This is derived metadata; it does not
   import, replay or rewrite financial records.
3. Deploy the reviewed application normally. Check that a signed-in notification
   link opens its selected payment and that Retry works after a connection error.
   Financial test cases should use the project's synthetic fixtures; do not
   mark a real payment failed or returned merely to test the release.

No new notification keys, forwarding keys, scheduler or Mac setup is needed for
this batch. Existing notification preferences remain unchanged. Users do not
need to run SQL or configure import summaries.

## What changes

Chat can resolve an unexplained alert as not completed after an explicit
confirmation. It retains the source and recorded fees. Returned money is linked
to an identified original payment; partial returns against the original are
supported without assuming the whole payment was refunded. Any unexplained
remainder requires clarification. Generic Skip stays removed.

The original outgoing payment must already be explained before an incoming
return can be linked. If it is still unclassified, Chat directs the user to the
original payment's earlier Chat message or notification first. It does not apply
an expense category to the incoming credit or invent the original purpose.

Chat renders after authentication and loads its selected payment independently
from older history and optional answer choices. Reads have visible error/retry
states. Notification taps bring the app forward before navigation; the worker
uses a public retry page for an offline or slow connection. No private page or
financial API response is cached for offline use.

## Import/export boundary

Accounting outcomes, linked refunds and fees are included in the usable core
data. Resolution audit records retain their original evidence through export
and re-export; importing them does not replay their old commands or turn old
bank IDs into actionable destination Chat confirmations. That boundary is
reported in coverage rather than pretending a saved audit is a new resolution.

The local engineering work does not apply these migrations, run the metadata
backfill, change live financial records, or activate collection or notifications.
