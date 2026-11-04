-- Cache the account array once during accounting-document validation.
-- Preserve the existing ABI, ownership, grants and validation behavior; reject definition drift.
do $guarded_cache_apply$
declare before_proc pg_catalog.pg_proc%rowtype; after_proc pg_catalog.pg_proc%rowtype;
begin
  select p.* into before_proc from pg_catalog.pg_proc p
    where p.oid=pg_catalog.to_regprocedure('public.alfred_accounting_document_valid(jsonb,uuid)');
  if not found then raise exception 'Accounting validator is missing; no change applied'; end if;
  if before_proc.prokind<>'f' or before_proc.prorettype<>'boolean'::regtype
    or before_proc.provolatile<>'i' or before_proc.prosecdef or before_proc.proisstrict
    or before_proc.proargnames is distinct from array['document','owner']::text[]
    or before_proc.proconfig is distinct from array['search_path=public']::text[]
    or before_proc.prolang<>(select oid from pg_catalog.pg_language where lanname='plpgsql') then
    raise exception 'Accounting validator ABI changed; no change applied';
  end if;
  if md5(before_proc.prosrc)='e113aff26bf807912cf27bd443c78ac7' then return; end if;
  if md5(before_proc.prosrc)<>'98941ba11780aec9d700633d4cef520b' then
    raise exception 'Accounting validator definition changed; no change applied';
  end if;
  execute $reviewed_cache_definition$
create or replace function public.alfred_accounting_document_valid(document jsonb, owner uuid)
returns boolean language plpgsql immutable set search_path = public as $$
declare item jsonb; account_rows jsonb;
begin
  if jsonb_typeof(document) is distinct from 'object' or document->>'ownerId' is distinct from owner::text
    or jsonb_typeof(document->'revision') is distinct from 'number' or (document->>'revision')::numeric < 0
    or (document->>'revision')::numeric > 9007199254740991
    or (document->>'revision')::numeric <> trunc((document->>'revision')::numeric) then return false; end if;
  account_rows := document->'accounts';
  foreach item in array array[account_rows,document->'movements',document->'snapshots',document->'transfers',document->'settlements',document->'audit'] loop
    if item is null or jsonb_typeof(item) is distinct from 'array' or jsonb_array_length(item)>50000 then return false; end if;
  end loop;
  if jsonb_array_length(document->'audit')>50 then return false; end if;
  for item in select value from jsonb_array_elements(document->'movements') loop
    if item->>'ownerId' is distinct from owner::text or jsonb_typeof(item->'amountMinor') is distinct from 'number'
      or (item->>'amountMinor')::numeric <= 0 or (item->>'amountMinor')::numeric > 9007199254740991
      or (item->>'amountMinor')::numeric <> trunc((item->>'amountMinor')::numeric)
      or jsonb_typeof(item->'feeMinor') is distinct from 'number' or (item->>'feeMinor')::numeric < 0 or (item->>'feeMinor')::numeric > 9007199254740991
      or (item->>'feeMinor')::numeric <> trunc((item->>'feeMinor')::numeric)
      or item->>'currency' is null or item->>'currency' !~ '^[A-Z]{3}$' then return false; end if;
    if item->>'accountId' is not null and not exists(select 1 from jsonb_array_elements(account_rows) a where a->>'id'=item->>'accountId' and a->>'currency'=item->>'currency') then return false; end if;
  end loop;
  for item in select value from jsonb_array_elements(document->'snapshots') loop
    if not exists(select 1 from jsonb_array_elements(account_rows) a where a->>'id'=item->>'accountId') then return false; end if;
  end loop;
  return true;
exception when others then return false;
end $$;
$reviewed_cache_definition$;
  select p.* into after_proc from pg_catalog.pg_proc p where p.oid=before_proc.oid;
  if not found or md5(after_proc.prosrc)<>'e113aff26bf807912cf27bd443c78ac7'
    or (to_jsonb(after_proc)-'prosrc') is distinct from (to_jsonb(before_proc)-'prosrc') then
    raise exception 'Accounting validator metadata changed unexpectedly; change rolled back';
  end if;
end $guarded_cache_apply$;
select md5(prosrc)='e113aff26bf807912cf27bd443c78ac7' as cached_validator,
  provolatile='i' as immutable, not prosecdef as invoker,
  proconfig=array['search_path=public']::text[] as expected_search_path
from pg_catalog.pg_proc
where oid=pg_catalog.to_regprocedure('public.alfred_accounting_document_valid(jsonb,uuid)');
