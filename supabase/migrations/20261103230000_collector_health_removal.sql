-- Remove only an owner's saved operational status. This does not stop a Mac,
-- revoke a forwarding key, or delete local alerts or financial records.
create or replace function public.alfred_forget_collector_health(owner uuid, device uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if owner is null or device is null then raise exception 'Invalid collector status selection'; end if;
  -- Share the reporter's per-owner lock: a removal and a new report cannot
  -- bypass the five-device cap or partially replace another device's status.
  perform pg_advisory_xact_lock(hashtextextended(owner::text,92351));
  delete from public.collector_health where owner_id=owner and device_id=device;
  return found;
end $$;
revoke all on function public.alfred_forget_collector_health(uuid,uuid) from public,anon,authenticated;
