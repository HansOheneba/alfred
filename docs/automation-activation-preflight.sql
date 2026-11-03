-- Read-only operator review. Run only through an already authorized connection
-- to Alfred's confirmed production database. This file never applies migrations,
-- creates a ledger, touches finance records, or reads notification payloads/keys.
begin read only;
select current_database() as database_name;
select to_regclass('public.alfred_schema_migrations') is not null as migration_ledger_present;
-- If migration_ledger_present is false, stop before the next statement and
-- resolve the baseline. Do not create an empty ledger over an existing schema.
select filename,applied_at from public.alfred_schema_migrations order by filename;
select expected.name, c.oid is not null as present, c.relrowsecurity as row_security
from (values
 ('notification_preferences'),('push_subscriptions'),('notification_deliveries'),
 ('bank_notice_receipts'),('collector_event_receipts'),('notification_recovery_health'),('collector_health')
) as expected(name)
left join pg_namespace n on n.nspname='public'
left join pg_class c on c.relnamespace=n.oid and c.relname=expected.name;
select expected.signature,to_regprocedure(expected.signature) is not null as present
from (values
 ('public.alfred_notifications_schema_20261103_v1()'),
 ('public.alfred_record_bank_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb)'),
 ('public.alfred_claim_collector_event(uuid,text,text)'),
 ('public.alfred_complete_collector_event(uuid,text,text,uuid,uuid[])'),
 ('public.alfred_release_collector_event(uuid,text,text,uuid)'),
 ('public.alfred_record_collector_health(uuid,uuid,text,integer,integer,integer,integer,integer,timestamp with time zone,timestamp with time zone)'),
 ('public.alfred_forget_collector_health(uuid,uuid)'),
 ('public.alfred_record_bank_activity_notice(uuid,uuid,text,text,boolean,text,uuid,boolean,jsonb,jsonb)')
) as expected(signature);
rollback;
