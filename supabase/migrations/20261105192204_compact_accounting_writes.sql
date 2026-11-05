-- Additive network transport only. Authoritative storage, events, source hashes,
-- validator behavior and the original writer ABI remain unchanged.
do $require_writer$
declare writer pg_catalog.pg_proc%rowtype;
begin
  select * into writer from pg_catalog.pg_proc where oid=pg_catalog.to_regprocedure('public.alfred_write_accounting_state(uuid,bigint,text,text,text,jsonb)');
  if not found or writer.prorettype<>'jsonb'::regtype or writer.prosecdef
    or writer.proargnames is distinct from array['owner','expected_revision','request_key','fingerprint','source_version','next_state']::text[] then
    raise exception 'The reviewed accounting writer ABI is unavailable';
  end if;
end $require_writer$;

create or replace function public.alfred_write_accounting_state_compact(
  owner uuid, expected_revision bigint, request_key text, fingerprint text, source_version text, next_state jsonb
) returns jsonb language plpgsql set search_path=public as $$
declare current_state jsonb; current_revision bigint; prior_fingerprint text; outcome jsonb;
  current_audit jsonb; incoming_audit jsonb; history jsonb; expected_metadata jsonb; incoming_metadata jsonb;
  history_count integer; incoming_count integer; response_state jsonb; response_audit jsonb;
begin
  -- Match the original writer's lock order. Reentrant delegation below retains
  -- its permanent request IDs, source locks/version check, validator and CAS.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,81627));
  select state,revision into current_state,current_revision from public.accounting_states where owner_id=owner for update;
  select action_fingerprint into prior_fingerprint from public.accounting_events where owner_id=owner and request_id=request_key;
  if found or coalesce(current_revision,0)<>expected_revision then
    outcome=public.alfred_write_accounting_state(owner,expected_revision,request_key,fingerprint,source_version,next_state);
  else
    current_audit=coalesce(current_state->'audit','[]'::jsonb);
    incoming_audit=next_state->'audit';
    if jsonb_typeof(current_audit) is distinct from 'array' or jsonb_typeof(incoming_audit) is distinct from 'array' then
      raise exception 'Compact accounting audit lineage is invalid';
    end if;
    history_count=least(jsonb_array_length(current_audit),49);
    incoming_count=jsonb_array_length(incoming_audit);
    if incoming_count<>history_count+1 then raise exception 'Compact accounting audit lineage changed'; end if;
    select coalesce(jsonb_agg(entry order by position),'[]'::jsonb),coalesce(jsonb_agg(entry-'before' order by position),'[]'::jsonb)
      into history,expected_metadata from jsonb_array_elements(current_audit) with ordinality as entries(entry,position)
      where position>jsonb_array_length(current_audit)-history_count;
    select coalesce(jsonb_agg(entry-'before' order by position),'[]'::jsonb) into incoming_metadata
      from jsonb_array_elements(incoming_audit) with ordinality as entries(entry,position) where position<incoming_count;
    if incoming_metadata is distinct from expected_metadata then raise exception 'Compact accounting audit metadata changed'; end if;
    -- Ignore every supplied historical before copy. Only authoritative copies
    -- are persisted; the new reducer entry includes its complete current-source before.
    next_state=jsonb_set(next_state,'{audit}',history||jsonb_build_array(incoming_audit->(incoming_count-1)));
    outcome=public.alfred_write_accounting_state(owner,expected_revision,request_key,fingerprint,source_version,next_state);
  end if;
  if jsonb_typeof(outcome->'state')='object' then
    response_state=outcome->'state';
    select coalesce(jsonb_agg(entry||jsonb_build_object('before',
      '{"accounts":[],"movements":[],"snapshots":[],"transfers":[],"settlements":[]}'::jsonb) order by position),'[]'::jsonb)
      into response_audit from jsonb_array_elements(response_state->'audit') with ordinality as entries(entry,position);
    outcome=jsonb_set(outcome,'{state}',jsonb_set(response_state,'{audit}',response_audit));
  end if;
  return outcome;
end $$;
revoke all on function public.alfred_write_accounting_state_compact(uuid,bigint,text,text,text,jsonb) from public,anon,authenticated;

-- Deployment marker: old deployments continue using the complete legacy path.
create or replace function public.alfred_compact_accounting_schema_20261105_v1()
returns text language sql immutable set search_path=public as $$ select 'alfred.compact-accounting:20261105:v1'::text $$;
revoke all on function public.alfred_compact_accounting_schema_20261105_v1() from public,anon,authenticated;
