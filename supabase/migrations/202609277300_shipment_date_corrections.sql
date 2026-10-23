-- Real dates for shipments that were executed before they were entered in Nexus.
--
-- Every action stamps the day it is done in Nexus: a stage gets started_at/completed_at = now(), a vehicle gets
-- actual_loading_date/actual_arrival_date = current_date, a receipt and its batches get received_at = now(). A
-- shipment that happened last month therefore looked as if everything happened today, and the report, the
-- stage durations and the FIFO order of its batches were wrong.
--
-- correct_shipment_dates sets the real dates afterwards:
--   * permission shipments.backdate and a reason; dates in the future are refused;
--   * stages: start and completion (only of a started or completed stage, start not after completion);
--   * vehicles: loading and arrival (only once the vehicle has loaded or arrived, loading not after arrival);
--   * receipts: the receiving day, also the received_at of the batches created by that receipt (FIFO order);
--     not before the arrival of the vehicle;
--   * a day is stored as midday in Almaty, so it shows as the same day everywhere; a day equal to the
--     stored one keeps the stored time;
--   * every change is kept in shipment_date_corrections with the previous value, the reason and the employee.
-- A closed shipment is still corrected: its closing stage is completed last. The protection of inactive
-- shipments lets through only this function and only changes of these date columns.

insert into public.permissions(code,module,action,name,description) values
  ('shipments.backdate','shipments','backdate','Поставки: фактические даты задним числом',
   'Исправление фактических дат этапов, автомобилей и приёмки уже исполненной поставки с указанием причины')
on conflict (code) do update set name=excluded.name,description=excluded.description;

insert into public.role_permissions(role_id,permission_id,granted)
select r.id,p.id,true from public.app_roles r cross join public.permissions p
where p.code='shipments.backdate' and r.code in ('administrator','director','executive_director','logistics_director')
on conflict (role_id,permission_id) do nothing;

create table if not exists public.shipment_date_corrections (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  entity_type text not null check (entity_type in ('stage_run', 'transport', 'receipt')),
  entity_id uuid not null,
  field text not null check (field in ('started_at', 'completed_at', 'actual_loading_date', 'actual_arrival_date', 'received_at')),
  previous_value text, -- ISO 8601: a day for vehicles, a moment for stages and receipts
  new_value text not null,
  reason text not null check (length(btrim(reason)) between 1 and 500),
  corrected_by uuid not null references public.profiles(id) on delete restrict,
  corrected_at timestamptz not null default now()
);
create index if not exists shipment_date_corrections_shipment_idx on public.shipment_date_corrections(shipment_id, corrected_at desc);

alter table public.shipment_date_corrections enable row level security;
revoke all on public.shipment_date_corrections from anon, authenticated, service_role;
grant select on public.shipment_date_corrections to authenticated;
drop policy if exists "shipment users view date corrections" on public.shipment_date_corrections;
create policy "shipment users view date corrections" on public.shipment_date_corrections
  for select to authenticated using ((select private.has_permission('shipments.view')));

comment on table public.shipment_date_corrections is 'Real dates entered afterwards for stages, vehicles and receipts, with the previous value and the reason';

-- The same protection as before, plus the one exception described above. Nobody can use the exception
-- elsewhere: employees cannot update these tables directly, and every other function changes more than
-- the date columns (status, people, quantities) or refuses a locked shipment itself.
create or replace function private.protect_inactive_shipment_children()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment_id uuid := case when tg_op = 'DELETE' then old.shipment_id else new.shipment_id end;
  v_status text;
  v_locked boolean;
  v_dates constant text[] := array['started_at', 'completed_at', 'actual_loading_date', 'actual_arrival_date', 'updated_at'];
begin
  select status,is_locked into v_status,v_locked from public.shipments where id=v_shipment_id;
  if v_locked or v_status in ('on_hold','cancelled','closed') then
    if tg_op = 'UPDATE' and v_status <> 'cancelled'
       and tg_table_name in ('shipment_stage_runs', 'shipment_transports')
       and current_setting('nexus.shipment_date_correction', true) = v_shipment_id::text
       and (to_jsonb(old) - v_dates) = (to_jsonb(new) - v_dates) then
      return new;
    end if;
    raise exception 'Поставка в статусе "%" недоступна для изменений',v_status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
revoke execute on function private.protect_inactive_shipment_children() from public;

-- A business day as a moment: midday in Almaty is the same calendar day in every time zone from UTC-6 to UTC+12.
create or replace function private.business_day_moment(p_day date)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_day + time '12:00') at time zone 'Asia/Almaty'
$$;

create or replace function private.correction_day(p_value jsonb, p_label text)
returns date language plpgsql immutable set search_path = '' as $$
declare v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    raise exception '%: укажите дату в формате ГГГГ-ММ-ДД', p_label;
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '%: укажите дату в формате ГГГГ-ММ-ДД', p_label;
  end if;
  begin
    return v_text::date;
  exception when others then
    raise exception '%: такой даты нет', p_label;
  end;
end $$;

create or replace function public.correct_shipment_dates(p_shipment_id uuid, p_changes jsonb, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.shipments%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  v_user uuid := (select auth.uid());
  v_entry jsonb; v_id uuid; v_day date; v_moment timestamptz; v_changed integer := 0;
  v_run record; v_transport record; v_receipt record;
  v_started timestamptz; v_completed timestamptz; v_loading date; v_arrival date;
  v_seen uuid[] := '{}';
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('shipments.backdate')) then
    raise exception 'Недостаточно прав для исправления фактических дат поставки' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'Укажите причину исправления дат'; end if;
  if length(v_reason) > 500 then raise exception 'Причина не должна быть длиннее 500 символов'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then raise exception 'Некорректные изменения дат'; end if;
  if exists (select 1 from jsonb_object_keys(p_changes) k where k not in ('stages', 'transports', 'receipts')) then
    raise exception 'Некорректные изменения дат';
  end if;
  if exists (select 1 from jsonb_each(p_changes) e where jsonb_typeof(e.value) <> 'array') then
    raise exception 'Некорректные изменения дат';
  end if;

  select * into s from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Поставка не найдена'; end if;
  if s.status = 'cancelled' then raise exception 'Даты отменённой поставки не исправляются'; end if;

  -- Only the date columns of this shipment, only inside this transaction.
  perform set_config('nexus.shipment_date_correction', s.id::text, true);

  -- Stages ---------------------------------------------------------------------------------------------
  for v_entry in select value from jsonb_array_elements(coalesce(p_changes -> 'stages', '[]')) loop
    begin v_id := (v_entry ->> 'id')::uuid; exception when others then raise exception 'Некорректный этап'; end;
    if v_id is null or v_id = any(v_seen) then raise exception 'Этап указан неверно или дважды'; end if;
    v_seen := v_seen || v_id;
    select run.id, run.status, run.started_at, run.completed_at, stage.name ->> 'ru' as stage_name into v_run
    from public.shipment_stage_runs run join public.shipment_stages stage on stage.id = run.stage_id
    where run.id = v_id and run.shipment_id = s.id for update of run;
    if not found then raise exception 'Этап не относится к этой поставке'; end if;
    v_started := v_run.started_at; v_completed := v_run.completed_at;
    if v_entry ? 'started_on' then
      if v_run.status not in ('in_progress', 'completed') then
        raise exception 'Этап «%» не начат: дату начала указать нельзя', v_run.stage_name;
      end if;
      v_day := private.correction_day(v_entry -> 'started_on', format('Начало этапа «%s»', v_run.stage_name));
      if v_day > v_today then raise exception 'Начало этапа «%» не может быть в будущем', v_run.stage_name; end if;
      if v_started is null or (v_started at time zone 'Asia/Almaty')::date <> v_day then
        v_started := private.business_day_moment(v_day);
      end if;
    end if;
    if v_entry ? 'completed_on' then
      if v_run.status <> 'completed' then
        raise exception 'Этап «%» не завершён: дату завершения указать нельзя', v_run.stage_name;
      end if;
      v_day := private.correction_day(v_entry -> 'completed_on', format('Завершение этапа «%s»', v_run.stage_name));
      if v_day > v_today then raise exception 'Завершение этапа «%» не может быть в будущем', v_run.stage_name; end if;
      if v_completed is null or (v_completed at time zone 'Asia/Almaty')::date <> v_day then
        v_completed := private.business_day_moment(v_day);
      end if;
    end if;
    if v_started is not null and v_completed is not null and v_started > v_completed then
      if (v_started at time zone 'Asia/Almaty')::date > (v_completed at time zone 'Asia/Almaty')::date then
        raise exception 'Этап «%»: начало позже завершения', v_run.stage_name;
      end if;
      v_started := v_completed; -- the same day: start at the moment of completion
    end if;
    if v_started is distinct from v_run.started_at then
      update public.shipment_stage_runs set started_at = v_started, updated_at = now() where id = v_run.id;
      insert into public.shipment_date_corrections(shipment_id, entity_type, entity_id, field, previous_value, new_value, reason, corrected_by)
      values (s.id, 'stage_run', v_run.id, 'started_at', to_jsonb(v_run.started_at) #>> '{}', to_jsonb(v_started) #>> '{}', v_reason, v_user);
      v_changed := v_changed + 1;
    end if;
    if v_completed is distinct from v_run.completed_at then
      update public.shipment_stage_runs set completed_at = v_completed, updated_at = now() where id = v_run.id;
      insert into public.shipment_date_corrections(shipment_id, entity_type, entity_id, field, previous_value, new_value, reason, corrected_by)
      values (s.id, 'stage_run', v_run.id, 'completed_at', to_jsonb(v_run.completed_at) #>> '{}', to_jsonb(v_completed) #>> '{}', v_reason, v_user);
      v_changed := v_changed + 1;
    end if;
  end loop;

  -- Vehicles -------------------------------------------------------------------------------------------
  for v_entry in select value from jsonb_array_elements(coalesce(p_changes -> 'transports', '[]')) loop
    begin v_id := (v_entry ->> 'id')::uuid; exception when others then raise exception 'Некорректный автомобиль'; end;
    if v_id is null or v_id = any(v_seen) then raise exception 'Автомобиль указан неверно или дважды'; end if;
    v_seen := v_seen || v_id;
    select t.id, t.sequence_no, t.status, t.actual_loading_date, t.actual_arrival_date into v_transport
    from public.shipment_transports t where t.id = v_id and t.shipment_id = s.id for update;
    if not found then raise exception 'Автомобиль не относится к этой поставке'; end if;
    if v_transport.status = 'cancelled' then raise exception 'Автомобиль №% отменён', v_transport.sequence_no; end if;
    v_loading := v_transport.actual_loading_date; v_arrival := v_transport.actual_arrival_date;
    if v_entry ? 'actual_loading_date' then
      if v_transport.status not in ('loading', 'in_transit', 'at_customs', 'arrived', 'unloaded') then
        raise exception 'Автомобиль №% ещё не загружался', v_transport.sequence_no;
      end if;
      v_loading := private.correction_day(v_entry -> 'actual_loading_date', format('Погрузка автомобиля №%s', v_transport.sequence_no));
      if v_loading > v_today then raise exception 'Погрузка автомобиля №% не может быть в будущем', v_transport.sequence_no; end if;
    end if;
    if v_entry ? 'actual_arrival_date' then
      if v_transport.status not in ('arrived', 'unloaded') then
        raise exception 'Автомобиль №% ещё не прибыл', v_transport.sequence_no;
      end if;
      v_arrival := private.correction_day(v_entry -> 'actual_arrival_date', format('Прибытие автомобиля №%s', v_transport.sequence_no));
      if v_arrival > v_today then raise exception 'Прибытие автомобиля №% не может быть в будущем', v_transport.sequence_no; end if;
    end if;
    if v_loading is not null and v_arrival is not null and v_loading > v_arrival then
      raise exception 'Автомобиль №%: погрузка позже прибытия', v_transport.sequence_no;
    end if;
    if v_loading is distinct from v_transport.actual_loading_date then
      update public.shipment_transports set actual_loading_date = v_loading, updated_at = now() where id = v_transport.id;
      insert into public.shipment_date_corrections(shipment_id, entity_type, entity_id, field, previous_value, new_value, reason, corrected_by)
      values (s.id, 'transport', v_transport.id, 'actual_loading_date', v_transport.actual_loading_date::text, v_loading::text, v_reason, v_user);
      v_changed := v_changed + 1;
    end if;
    if v_arrival is distinct from v_transport.actual_arrival_date then
      update public.shipment_transports set actual_arrival_date = v_arrival, updated_at = now() where id = v_transport.id;
      insert into public.shipment_date_corrections(shipment_id, entity_type, entity_id, field, previous_value, new_value, reason, corrected_by)
      values (s.id, 'transport', v_transport.id, 'actual_arrival_date', v_transport.actual_arrival_date::text, v_arrival::text, v_reason, v_user);
      v_changed := v_changed + 1;
    end if;
  end loop;

  -- Receipts and their batches -------------------------------------------------------------------------
  for v_entry in select value from jsonb_array_elements(coalesce(p_changes -> 'receipts', '[]')) loop
    begin v_id := (v_entry ->> 'id')::uuid; exception when others then raise exception 'Некорректная приёмка'; end;
    if v_id is null or v_id = any(v_seen) then raise exception 'Приёмка указана неверно или дважды'; end if;
    v_seen := v_seen || v_id;
    select r.id, r.received_at, t.sequence_no into v_receipt
    from public.shipment_transport_receipts r join public.shipment_transports t on t.id = r.shipment_transport_id
    where r.id = v_id and r.shipment_id = s.id for update of r;
    if not found then raise exception 'Приёмка не относится к этой поставке'; end if;
    if not (v_entry ? 'received_on') then continue; end if;
    v_day := private.correction_day(v_entry -> 'received_on', format('Приёмка автомобиля №%s', v_receipt.sequence_no));
    if v_day > v_today then raise exception 'Приёмка автомобиля №% не может быть в будущем', v_receipt.sequence_no; end if;
    continue when (v_receipt.received_at at time zone 'Asia/Almaty')::date = v_day;
    v_moment := private.business_day_moment(v_day);
    update public.shipment_transport_receipts set received_at = v_moment where id = v_receipt.id;
    update public.inventory_batches b set received_at = v_moment, updated_at = now()
    where b.id in (select ri.inventory_batch_id from public.shipment_transport_receipt_items ri
                   where ri.receipt_id = v_receipt.id and ri.inventory_batch_id is not null);
    insert into public.shipment_date_corrections(shipment_id, entity_type, entity_id, field, previous_value, new_value, reason, corrected_by)
    values (s.id, 'receipt', v_receipt.id, 'received_at', to_jsonb(v_receipt.received_at) #>> '{}', to_jsonb(v_moment) #>> '{}', v_reason, v_user);
    v_changed := v_changed + 1;
  end loop;

  -- Goods are received after the vehicle arrives (checked on the final dates of both).
  select t.sequence_no into v_transport
  from public.shipment_transport_receipts r join public.shipment_transports t on t.id = r.shipment_transport_id
  where r.shipment_id = s.id and t.actual_arrival_date is not null
    and (r.received_at at time zone 'Asia/Almaty')::date < t.actual_arrival_date
  limit 1;
  if found then raise exception 'Автомобиль №%: приёмка раньше прибытия', v_transport.sequence_no; end if;

  return jsonb_build_object('changed', v_changed);
end $$;

do $$ declare f text; begin
  foreach f in array array['private.business_day_moment(date)','private.correction_day(jsonb,text)'] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  end loop;
end $$;
revoke all on function public.correct_shipment_dates(uuid, jsonb, text) from public, anon, service_role;
grant execute on function public.correct_shipment_dates(uuid, jsonb, text) to authenticated;

comment on function public.correct_shipment_dates(uuid, jsonb, text) is
  'Sets the real dates of stages, vehicles and receipts of an executed shipment, with a reason and history (shipments.backdate)';
