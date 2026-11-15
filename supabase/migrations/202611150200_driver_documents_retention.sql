-- Retention of drivers' IIN and document requisites (owner decision of 2026-11-15).
--
-- Rule: when a driver has had no activity for 12 months, the IIN and the document requisites are
-- removed from the directory and from every copy of them in the directory history. Activity is the
-- latest of: the driver card being created, any saved change of the card or of its documents, and any
-- saved trip version that names the driver. Name, phones, trips and the rest of the history remain.
-- Trip snapshots never contained the IIN (202611100300), so trips are not touched.
--
-- The removal runs only from a scheduled job (service_role or pg_cron); opening a page never deletes.
-- Each removal is logged without the removed values.
begin;

create table if not exists private.freight_driver_document_purges (
 id uuid primary key default gen_random_uuid(),
 driver_id uuid not null references public.freight_drivers(id),
 last_activity_at timestamptz not null,
 purged_at timestamptz not null default clock_timestamp(),
 history_rows integer not null check (history_rows>=0),
 rule text not null
);
create index if not exists freight_driver_document_purges_driver_idx on private.freight_driver_document_purges(driver_id,purged_at desc);
alter table private.freight_driver_document_purges enable row level security;
revoke all on private.freight_driver_document_purges from public,anon,authenticated,service_role;

-- The removed fields, as stored by save_freight_directory for kind 'driver_documents'.
create or replace function private.freight_redact_driver_documents(p_value jsonb) returns jsonb
language sql immutable set search_path='' as $$
 select case when p_value is null then null
  else p_value || jsonb_build_object('iin',null,'document_requisites',null) end
$$;
revoke all on function private.freight_redact_driver_documents(jsonb) from public,anon,authenticated,service_role;

-- The directory history stays immutable. The single exception is the retention removal itself: only
-- inside a transaction that has switched it on, only for 'driver_documents' rows, and only the change
-- that blanks the IIN and requisites. Every other column and every other value must stay the same.
-- Trip versions keep their own, unchanged guard (private.guard_freight_history).
create or replace function private.guard_freight_directory_history() returns trigger
language plpgsql set search_path='' as $$
begin
 if tg_op='UPDATE'
  and coalesce(current_setting('nexus.freight_retention_purge',true),'')='on'
  and old.kind='driver_documents'
  and (new.id,new.kind,new.entity_id,new.actor_id,new.reason,new.created_at)
      is not distinct from (old.id,old.kind,old.entity_id,old.actor_id,old.reason,old.created_at)
  and new.before_value is not distinct from private.freight_redact_driver_documents(old.before_value)
  and new.after_value is not distinct from private.freight_redact_driver_documents(old.after_value) then
  return new;
 end if;
 raise exception 'История перевозок неизменяема' using errcode='42501';
end$$;
revoke all on function private.guard_freight_directory_history() from public,anon,authenticated,service_role;
drop trigger if exists freight_history_immutable on private.freight_directory_history;
create trigger freight_history_immutable before update or delete on private.freight_directory_history
 for each row execute function private.guard_freight_directory_history();

create or replace function private.freight_driver_last_activity(p_driver uuid) returns timestamptz
language sql stable security definer set search_path='' as $$
 select greatest(
  (select d.created_at from public.freight_drivers d where d.id=p_driver),
  (select max(h.created_at) from private.freight_directory_history h
    where h.entity_id=p_driver and h.kind in ('driver','driver_documents')),
  (select max(v.created_at) from private.freight_trip_versions v
    where v.snapshot->'driver'->>'id'=p_driver::text)
 )
$$;
revoke all on function private.freight_driver_last_activity(uuid) from public,anon,authenticated,service_role;

create or replace function private.purge_expired_driver_documents(p_now timestamptz) returns integer
language plpgsql security definer set search_path='' as $$
declare
 retention constant interval := interval '12 months';
 candidate uuid;
 last_at timestamptz;
 history_count integer;
 purged integer := 0;
begin
 if p_now is null or not isfinite(p_now) then raise exception 'Некорректное время удаления' using errcode='22023'; end if;
 for candidate in
  select d.driver_id from private.freight_driver_documents d
   where d.iin is not null or d.document_requisites is not null
  union
  select h.entity_id from private.freight_directory_history h
   where h.kind='driver_documents'
     and (h.before_value->>'iin' is not null or h.before_value->>'document_requisites' is not null
       or h.after_value->>'iin' is not null or h.after_value->>'document_requisites' is not null)
  order by 1
 loop
  -- The same lock save_freight_directory takes for the documents of this driver: a save that is in
  -- progress finishes first, and its fresh history then counts as activity below.
  -- The card lock covers a concurrent edit of the driver; the row lock waits for a trip being saved
  -- with this driver (save_freight_trip holds the driver row FOR SHARE).
  perform pg_advisory_xact_lock(hashtextextended('freight-directory:driver:'||candidate,0));
  perform pg_advisory_xact_lock(hashtextextended('freight-directory:driver_documents:'||candidate,0));
  perform 1 from public.freight_drivers where id=candidate for update;
  last_at := private.freight_driver_last_activity(candidate);
  if last_at is null or last_at >= p_now - retention then continue; end if;

  update private.freight_driver_documents
     set iin=null, document_requisites=null, version=version+1
   where driver_id=candidate and (iin is not null or document_requisites is not null);

  perform set_config('nexus.freight_retention_purge','on',true);
  update private.freight_directory_history h
     set before_value=private.freight_redact_driver_documents(h.before_value),
         after_value=private.freight_redact_driver_documents(h.after_value)
   where h.kind='driver_documents' and h.entity_id=candidate
     and (h.before_value->>'iin' is not null or h.before_value->>'document_requisites' is not null
       or h.after_value->>'iin' is not null or h.after_value->>'document_requisites' is not null);
  get diagnostics history_count = row_count;
  perform set_config('nexus.freight_retention_purge','',true);

  -- Idempotency keys hold a digest of the submitted values, IIN included. After 12 months without
  -- activity no repeat of those requests is expected, so their keys are removed as well.
  delete from private.freight_directory_requests where result_id=candidate;

  insert into private.freight_driver_document_purges(driver_id,last_activity_at,history_rows,rule)
  values(candidate,last_at,history_count,'12 месяцев без активности водителя');
  purged := purged + 1;
 end loop;
 return purged;
end$$;
revoke all on function private.purge_expired_driver_documents(timestamptz) from public,anon,authenticated,service_role;

-- Entry point for the schedule (pg_cron or a server job with the secret key), like run_shelf_life_control.
create or replace function public.purge_expired_driver_documents() returns integer
language sql security definer set search_path='' as $$
 select private.purge_expired_driver_documents(clock_timestamp())
$$;
revoke all on function public.purge_expired_driver_documents() from public,anon,authenticated,service_role;
grant execute on function public.purge_expired_driver_documents() to service_role;

commit;
