-- Derived identity facts, not financial records or collection permissions. No existing archive is backfilled here.
alter table public.finance_import_receipts add column if not exists provider_identity_summary jsonb;
alter table public.finance_import_receipts add column if not exists provider_identity_summary_version integer;
alter table public.finance_import_receipts add column if not exists provider_identity_archive_id text;
alter table public.finance_import_receipts add column if not exists provider_identity_summary_fingerprint text;

create or replace function public.alfred_import_provider_summary_fingerprint(owner uuid,receipt_key text,archive_hash text,summary jsonb)
returns text language sql immutable strict set search_path=public,pg_temp as $$
 select md5(owner::text||':'||receipt_key||':'||archive_hash||':1:'||summary::text)
$$;

create or replace function public.alfred_derive_import_provider_summary(owner uuid,receipt_key text,archive_hash text,document jsonb,saved_state jsonb)
returns jsonb language plpgsql immutable set search_path=public,pg_temp as $$
declare facts jsonb;
begin
 if archive_hash is null or archive_hash !~ '^[a-f0-9]{64}$' or document->>'archiveId' is distinct from archive_hash
    or saved_state->>'ownerId' is distinct from owner::text or jsonb_typeof(saved_state->'accounts') is distinct from 'array' then return null; end if;
 select coalesce(jsonb_agg(distinct jsonb_build_object('accountId',a->>'id','namespace',a#>>'{importProvenance,namespace}',
   'sourceId',a#>>'{importProvenance,sourceId}','provider',case a#>>'{importProvenance,sourceId}' when 'hubtel-wallet' then 'hubtel' else 'momo' end,
   'currency','GHS','includeInCash',true)),'[]'::jsonb) into facts
 from jsonb_array_elements(saved_state->'accounts') a
 where a->>'provider'='Imported Money Tracker' and a->>'currency'='GHS' and a->'includeInCash'='true'::jsonb
   and char_length(a->>'id') between 1 and 200 and char_length(a#>>'{importProvenance,namespace}') between 1 and 300
   and a#>>'{importProvenance,sourceId}' in ('hubtel-wallet','mtn-momo')
   and exists(select 1 from (
     select document as retained
     union all select coalesce(e->'archive',e) from jsonb_array_elements(case when jsonb_typeof(document#>'{datasets,preservedArchives}')='array' then document#>'{datasets,preservedArchives}' else '[]'::jsonb end) e
     union all select coalesce(e->'archive',e) from jsonb_array_elements(case when jsonb_typeof(document#>'{datasets,alfred.native,retainedArchives}')='array' then document#>'{datasets,alfred.native,retainedArchives}' else '[]'::jsonb end) e
     union all select coalesce(e->'archive',e) from jsonb_array_elements(case when jsonb_typeof(document#>'{datasets,moneyTracker.native,retainedArchives}')='array' then document#>'{datasets,moneyTracker.native,retainedArchives}' else '[]'::jsonb end) e
   ) sources
   where retained#>>'{manifest,sourceApp}'='money-tracker' and retained#>>'{manifest,namespace}'=a#>>'{importProvenance,namespace}'
     and retained#>>'{manifest,currency}'='GHS' and retained#>>'{datasets,moneyTracker.native,snapshot,currency}'='GHS'
     and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(retained#>'{datasets,accounts}')='array' then retained#>'{datasets,accounts}' else '[]'::jsonb end) core
       where coalesce(core#>>'{importProvenance,namespace}',retained#>>'{manifest,namespace}')=a#>>'{importProvenance,namespace}'
         and coalesce(core#>>'{importProvenance,sourceId}',core->>'id')=a#>>'{importProvenance,sourceId}'
         and core->>'provider'='Imported Money Tracker' and core->>'currency'='GHS' and core->'includeInCash'='true'::jsonb)
     and exists(select 1 from jsonb_array_elements(case when jsonb_typeof(retained#>'{datasets,moneyTracker.native,snapshot,accounts}')='array' then retained#>'{datasets,moneyTracker.native,snapshot,accounts}' else '[]'::jsonb end) native
       where native->>'account'=a#>>'{importProvenance,sourceId}' and native->'cash'='true'::jsonb));
 if jsonb_array_length(facts)>100 or octet_length(facts::text)>64000 then return jsonb_build_object('schema',1,'facts','[]'::jsonb,'limited',true); end if;
 return jsonb_build_object('schema',1,'facts',facts);
end $$;

create or replace function public.alfred_derive_import_provider_summary_trigger()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
 -- Receipt source and identity are immutable audit evidence. Normal undo and notification metadata updates remain available.
 if tg_op='UPDATE' and (new.owner_id is distinct from old.owner_id or new.id is distinct from old.id
    or new.archive_id is distinct from old.archive_id or new.archive is distinct from old.archive or new.after_state is distinct from old.after_state) then
   raise exception 'Import receipt identity and source evidence are immutable';
 end if;
 new.provider_identity_summary=public.alfred_derive_import_provider_summary(new.owner_id,new.id,new.archive_id,new.archive,new.after_state);
 if new.provider_identity_summary is null then raise exception 'Stored import archive lineage could not be verified'; end if;
 new.provider_identity_summary_version=1;
 new.provider_identity_archive_id=new.archive_id;
 new.provider_identity_summary_fingerprint=public.alfred_import_provider_summary_fingerprint(new.owner_id,new.id,new.archive_id,new.provider_identity_summary);
 return new;
end $$;
drop trigger if exists derive_import_provider_summary on public.finance_import_receipts;
create trigger derive_import_provider_summary before insert or update of owner_id,id,archive_id,archive,after_state,
 provider_identity_summary,provider_identity_summary_version,provider_identity_archive_id,provider_identity_summary_fingerprint
 on public.finance_import_receipts for each row execute function public.alfred_derive_import_provider_summary_trigger();

create or replace function public.alfred_backfill_import_provider_summary(owner uuid,receipt_key text)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare receipt public.finance_import_receipts;
begin
 select * into receipt from public.finance_import_receipts where owner_id=owner and id=receipt_key for update skip locked;
 if not found then return jsonb_build_object('status','missing_or_busy'); end if;
 if receipt.undone_at is not null then return jsonb_build_object('status','undone'); end if;
 if receipt.provider_identity_summary_version=1 and receipt.provider_identity_archive_id=receipt.archive_id
   and receipt.provider_identity_summary_fingerprint=public.alfred_import_provider_summary_fingerprint(owner,receipt.id,receipt.archive_id,receipt.provider_identity_summary) then return jsonb_build_object('status','current'); end if;
 if public.alfred_derive_import_provider_summary(owner,receipt.id,receipt.archive_id,receipt.archive,receipt.after_state) is null then return jsonb_build_object('status','corrupt'); end if;
 -- The trigger, not this caller's supplied JSON, computes the trusted summary. One receipt per explicit call.
 update public.finance_import_receipts set provider_identity_summary=null where owner_id=owner and id=receipt_key;
 return jsonb_build_object('status','prepared');
end $$;

create or replace function public.alfred_import_provider_facts(owner uuid,requested jsonb)
returns jsonb language plpgsql set search_path=public,pg_temp as $$
declare facts jsonb='[]'::jsonb; extra jsonb; legacy record; legacy_count integer; corrupt boolean=false; missing boolean;
begin
 if jsonb_typeof(requested) is distinct from 'array' or jsonb_array_length(requested)>100 then return jsonb_build_object('facts',facts,'status','invalid'); end if;
 if exists(select 1 from public.finance_import_receipts r where r.owner_id=owner and r.undone_at is null
    and (r.provider_identity_summary is not null or r.provider_identity_summary_version is not null or r.provider_identity_archive_id is not null or r.provider_identity_summary_fingerprint is not null)
    and (r.provider_identity_summary_version is distinct from 1 or r.provider_identity_archive_id is distinct from r.archive_id
      or r.provider_identity_summary->>'schema' is distinct from '1' or jsonb_typeof(r.provider_identity_summary->'facts') is distinct from 'array'
      or octet_length(r.provider_identity_summary::text)>65536
      or r.provider_identity_summary_fingerprint is distinct from public.alfred_import_provider_summary_fingerprint(owner,r.id,r.archive_id,r.provider_identity_summary))) then
   return jsonb_build_object('facts',facts,'status','corrupt');
 end if;
 select coalesce(jsonb_agg(distinct jsonb_build_object('account_id',w.account_id,'provider',w.provider)),'[]'::jsonb) into facts
 from (select r.id,r.provider_identity_summary from public.finance_import_receipts r
   where r.owner_id=owner and r.undone_at is null and r.provider_identity_summary_version=1 and r.provider_identity_archive_id=r.archive_id
     and r.provider_identity_summary_fingerprint=public.alfred_import_provider_summary_fingerprint(owner,r.id,r.archive_id,r.provider_identity_summary)
     and exists(select 1 from jsonb_array_elements(r.provider_identity_summary->'facts') candidate
       cross join jsonb_to_recordset(requested) as wanted(account_id text,namespace text,source_id text,provider text)
       where candidate->>'accountId'=wanted.account_id and candidate->>'namespace'=wanted.namespace and candidate->>'sourceId'=wanted.source_id and candidate->>'provider'=wanted.provider)
   for share of r skip locked) receipt
 cross join lateral jsonb_array_elements(receipt.provider_identity_summary->'facts') f
 cross join jsonb_to_recordset(requested) as w(account_id text,namespace text,source_id text,provider text)
 where f->>'accountId'=w.account_id and f->>'namespace'=w.namespace and f->>'sourceId'=w.source_id and f->>'provider'=w.provider
   and f->>'currency'='GHS' and f->'includeInCash'='true'::jsonb;
 select exists(select 1 from jsonb_to_recordset(requested) as w(account_id text)
   where not exists(select 1 from jsonb_array_elements(facts) f where f->>'account_id'=w.account_id)) into missing;
 if not missing then return jsonb_build_object('facts',facts,'status','summary'); end if;
 select count(*) into legacy_count from (select 1 from public.finance_import_receipts r where r.owner_id=owner and r.undone_at is null
   and r.provider_identity_summary is null and r.provider_identity_summary_version is null and r.provider_identity_archive_id is null and r.provider_identity_summary_fingerprint is null limit 3) bounded;
 if legacy_count>2 then return jsonb_build_object('facts','[]'::jsonb,'status','backfill-required','legacyLimited',true); end if;
 for legacy in select r.id,r.archive_id,r.archive,r.after_state from public.finance_import_receipts r
   where r.owner_id=owner and r.undone_at is null and r.provider_identity_summary is null and r.provider_identity_summary_version is null
     and r.provider_identity_archive_id is null and r.provider_identity_summary_fingerprint is null
   order by r.id limit 2 for share of r skip locked
 loop
   extra=public.alfred_derive_import_provider_summary(owner,legacy.id,legacy.archive_id,legacy.archive,legacy.after_state);
   if extra is null then corrupt=true; continue; end if;
   select facts||coalesce(jsonb_agg(distinct jsonb_build_object('account_id',w.account_id,'provider',w.provider)),'[]'::jsonb) into facts
   from jsonb_array_elements(extra->'facts') f cross join jsonb_to_recordset(requested) as w(account_id text,namespace text,source_id text,provider text)
   where f->>'accountId'=w.account_id and f->>'namespace'=w.namespace and f->>'sourceId'=w.source_id and f->>'provider'=w.provider;
 end loop;
 if corrupt then return jsonb_build_object('facts','[]'::jsonb,'status','corrupt'); end if;
 select exists(select 1 from jsonb_to_recordset(requested) as w(account_id text)
   where not exists(select 1 from jsonb_array_elements(facts) f where f->>'account_id'=w.account_id)) into missing;
 if missing then return jsonb_build_object('facts','[]'::jsonb,'status','incomplete','needsBackfill',legacy_count>0); end if;
 return jsonb_build_object('facts',facts,'status',case when legacy_count>0 then 'legacy-fallback' else 'summary' end,'needsBackfill',legacy_count>0);
end $$;

revoke all on function public.alfred_import_provider_summary_fingerprint(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.alfred_derive_import_provider_summary(uuid,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.alfred_derive_import_provider_summary_trigger() from public,anon,authenticated;
revoke all on function public.alfred_backfill_import_provider_summary(uuid,text) from public,anon,authenticated;
revoke all on function public.alfred_import_provider_facts(uuid,jsonb) from public,anon,authenticated;
