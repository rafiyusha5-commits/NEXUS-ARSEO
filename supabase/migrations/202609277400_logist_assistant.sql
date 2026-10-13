-- «Логист»: an assistant that prepares logistics actions and waits for an employee's decision.
--
-- Logist never changes a shipment by itself. Its rules look at active shipments and put proposals into a queue;
-- an employee accepts or rejects each one. Accepting runs the same function the employee's own button would run,
-- with the employee's own rights, so a proposal can never do what its reviewer may not.
--
-- Rules (deterministic, no language model):
--   complete_stage         — every mandatory document of the next stage is attached (the same rule as «Сверка»);
--   bind_document_vehicle  — an unconfirmed document of a shipment with several vehicles carries the plate of
--                            exactly one of them;
--   follow_up_task         — a vehicle has not arrived by its planned day, or a stage is past its due time:
--                            a task for the responsible employee.
--
-- A proposal is made once per situation (dedupe_key): a rejected one is not repeated, and one whose situation has
-- passed (the stage was completed by hand, the vehicle arrived) becomes obsolete. Accepting re-checks the situation
-- first. The responsible employee of the shipment is notified about new proposals.

create table if not exists public.logist_proposals (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references public.shipments(id) on delete cascade,
  kind text not null check (kind in ('complete_stage', 'bind_document_vehicle', 'follow_up_task')),
  title text not null check (length(title) between 1 and 300),
  reason text not null check (length(reason) between 1 and 1000),
  action jsonb not null check (jsonb_typeof(action) = 'object'),
  dedupe_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected', 'obsolete')),
  created_at timestamptz not null default now(),
  decided_by uuid references public.profiles(id) on delete restrict,
  decided_at timestamptz,
  decision_note text check (decision_note is null or length(decision_note) <= 500),
  result jsonb,
  check (status not in ('accepted', 'rejected') or (decided_by is not null and decided_at is not null))
);
create index if not exists logist_proposals_pending_idx on public.logist_proposals(created_at desc) where status = 'pending';
create index if not exists logist_proposals_shipment_idx on public.logist_proposals(shipment_id, status, created_at desc);

alter table public.logist_proposals enable row level security;
revoke all on public.logist_proposals from anon, authenticated, service_role;
grant select on public.logist_proposals to authenticated;
-- Proposals name documents of the shipment: the same access as the recognised source documents.
drop policy if exists "shipment users view logist proposals" on public.logist_proposals;
create policy "shipment users view logist proposals" on public.logist_proposals for select to authenticated
  using ((select private.has_permission('shipments.view')) and (select private.has_permission('documents.view')));

comment on table public.logist_proposals is 'Logistics actions prepared by the Logist assistant and decided by an employee';

-- The permission an employee needs to decide (accept or reject) a proposal of this kind.
create or replace function private.logist_kind_permission(p_kind text)
returns text language sql immutable set search_path = '' as $$
  select case p_kind when 'complete_stage' then 'shipments.change_status'
                     when 'bind_document_vehicle' then 'source_documents.extract'
                     when 'follow_up_task' then 'tasks.create' end
$$;

create or replace function private.logist_day(p_value date)
returns text language sql immutable set search_path = '' as $$
  select to_char(p_value, 'DD.MM.YYYY')
$$;

-- What Logist would propose for a shipment right now.
create or replace function private.logist_candidates(p_shipment_id uuid, p_today date)
returns table (kind text, title text, reason text, action jsonb, dedupe_key text)
language sql
stable
security definer
set search_path = ''
as $$
  with s as (
    select * from public.shipments where id = p_shipment_id
  ), runs as (
    select run.id, run.stage_id, run.status, run.is_required, run.shipment_transport_id, run.due_at,
           st.code, coalesce(st.name ->> 'ru', st.code) as stage_name, st.sequence_order, t.sequence_no
    from public.shipment_stage_runs run
    join public.shipment_stages st on st.id = run.stage_id
    left join public.shipment_transports t on t.id = run.shipment_transport_id
    where run.shipment_id = p_shipment_id
  ), missing as (
    select f ->> 'field' as type_code, nullif(f ->> 'transport_id', '')::uuid as transport_id
    from jsonb_array_elements(private.document_check_findings(p_shipment_id, p_today)) f
    where f ->> 'code' = 'document_missing'
  ), stage_documents as (
    select r.stage_id, dt.code, dt.name_ru
    from public.document_requirements r
    join public.document_types dt on dt.id = r.document_type_id
    join s on (r.shipment_type is null or r.shipment_type = s.type)
          and (r.process_template_id is null or r.process_template_id = s.process_template_id)
          and (r.route_id is null or r.route_id = s.route_id)
    where r.is_active and r.is_mandatory and r.stage_id is not null
  ), vehicles as (
    select t.* from public.shipment_transports t where t.shipment_id = p_shipment_id and t.status <> 'cancelled'
  )
  -- The next stage whose mandatory documents are all attached.
  select 'complete_stage',
         format('Завершить этап «%s»%s', run.stage_name, case when run.sequence_no is not null then format(' (автомобиль №%s)', run.sequence_no) else '' end),
         'Все обязательные документы этапа на месте: '
           || (select string_agg(distinct sd.name_ru, ', ') from stage_documents sd where sd.stage_id = run.stage_id)
           || '. Предыдущие этапы завершены.',
         jsonb_build_object('stage_run_id', run.id),
         'complete_stage:' || run.id
  from runs run
  where run.is_required and run.status in ('pending', 'in_progress') and run.code <> 'closed'
    and exists (select 1 from stage_documents sd where sd.stage_id = run.stage_id)
    and not exists (
      select 1 from stage_documents sd join missing m on m.type_code = sd.code
      where sd.stage_id = run.stage_id
        and (m.transport_id is null or run.shipment_transport_id is null or m.transport_id = run.shipment_transport_id))
    and not exists (
      select 1 from runs prev
      where prev.is_required and prev.sequence_order < run.sequence_order
        and prev.status not in ('completed', 'skipped', 'not_applicable')
        and (run.shipment_transport_id is null or prev.shipment_transport_id is null or prev.shipment_transport_id = run.shipment_transport_id))

  union all
  -- A document of a shipment with several vehicles that names exactly one of them.
  select 'bind_document_vehicle',
         format('Привязать «%s» к автомобилю №%s', d.title, m.sequence_no),
         format('Госномер %s в документе совпадает с автомобилем №%s; пока документ не привязан, данные водителя и машины из него не записываются.',
                m.plate, m.sequence_no),
         jsonb_build_object('extraction_id', e.id, 'transport_id', m.ids[1]),
         'bind_document_vehicle:' || e.id || ':' || m.ids[1]
  from public.shipment_source_extractions e
  join public.documents d on d.id = e.document_id
  cross join lateral (
    -- Vehicles whose plate or trailer plate is written in the document (empty plates never match).
    select array_agg(distinct v.id) as ids, min(v.sequence_no) as sequence_no, min(p.value) as plate
    from vehicles v
    cross join lateral (values
      (e.extracted_data ->> 'vehicle_plate', v.vehicle_plate),
      (e.extracted_data ->> 'trailer_plate', v.trailer_plate)) p(value, card)
    where private.normalize_plate(p.value) <> '' and private.normalize_plate(p.value) = private.normalize_plate(p.card)
  ) m
  where e.shipment_id = p_shipment_id and e.status in ('extracted', 'needs_review') and e.shipment_transport_id is null
    and (select count(*) from vehicles) > 1
    and cardinality(m.ids) = 1

  union all
  -- A vehicle past its planned arrival.
  select 'follow_up_task',
         format('Уточнить прибытие автомобиля №%s', v.sequence_no),
         format('Плановое прибытие %s прошло, автомобиль не отмечен прибывшим.', private.logist_day(v.planned_arrival_date)),
         jsonb_build_object('task_title', format('Уточнить прибытие автомобиля №%s поставки %s', v.sequence_no, s.shipment_number),
                            'task_description', format('Плановое прибытие %s прошло. Узнайте у перевозчика, где машина, и отметьте прибытие или новую дату.', private.logist_day(v.planned_arrival_date)),
                            'assignee_user_id', s.responsible_user_id, 'stage_run_id', null),
         'follow_up_arrival:' || v.id || ':' || v.planned_arrival_date
  from vehicles v cross join s
  where v.status in ('planned', 'loading', 'in_transit', 'at_customs') and v.planned_arrival_date < p_today
    and not exists (select 1 from public.tasks tk where tk.shipment_id = p_shipment_id and tk.status in ('open', 'in_progress')
                    and tk.title = format('Уточнить прибытие автомобиля №%s поставки %s', v.sequence_no, s.shipment_number))

  union all
  -- A stage past its due time without an open task.
  select 'follow_up_task',
         format('Этап «%s»%s просрочен', run.stage_name, case when run.sequence_no is not null then format(' (автомобиль №%s)', run.sequence_no) else '' end),
         format('Срок этапа был %s, этап не завершён.', private.logist_day((run.due_at at time zone 'Asia/Almaty')::date)),
         jsonb_build_object('task_title', format('Выполнить этап «%s» поставки %s', run.stage_name, s.shipment_number),
                            'task_description', format('Срок этапа был %s. Выполните этап или укажите в нём причину задержки.', private.logist_day((run.due_at at time zone 'Asia/Almaty')::date)),
                            'assignee_user_id', s.responsible_user_id, 'stage_run_id', run.id),
         'follow_up_stage:' || run.id || ':' || (run.due_at at time zone 'Asia/Almaty')::date
  from runs run cross join s
  where run.is_required and run.status in ('pending', 'in_progress', 'blocked') and run.due_at < now()
    and not exists (select 1 from public.tasks tk where tk.stage_run_id = run.id and tk.status in ('open', 'in_progress'))
$$;

-- Brings the queue of one shipment up to date: new situations become proposals, passed ones obsolete.
create or replace function private.logist_refresh(p_shipment_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.shipments%rowtype;
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  v_rows jsonb;
  v_keys text[];
  v_new integer := 0;
begin
  select * into s from public.shipments where id = p_shipment_id;
  if not found then return 0; end if;
  if s.is_locked or s.status in ('closed', 'cancelled', 'on_hold') then
    update public.logist_proposals set status = 'obsolete' where shipment_id = s.id and status = 'pending';
    return 0;
  end if;
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb) into v_rows from private.logist_candidates(s.id, v_today) c;
  select coalesce(array_agg(r ->> 'dedupe_key'), '{}') into v_keys from jsonb_array_elements(v_rows) r;
  update public.logist_proposals set status = 'obsolete'
  where shipment_id = s.id and status = 'pending' and not (dedupe_key = any(v_keys));
  insert into public.logist_proposals(shipment_id, kind, title, reason, action, dedupe_key)
  select s.id, c.kind, left(c.title, 300), left(c.reason, 1000), c.action, c.dedupe_key
  from jsonb_to_recordset(v_rows) c(kind text, title text, reason text, action jsonb, dedupe_key text)
  on conflict (dedupe_key) do nothing;
  get diagnostics v_new = row_count;
  if v_new > 0 and s.responsible_user_id is not null then
    perform private.notify(s.responsible_user_id, 'system', 'Логист: новые предложения',
      format('Поставка %s: предложений, ждущих решения, — %s.', s.shipment_number, v_new),
      'shipment', s.id, s.id, 'logist:' || s.id || ':' || md5(array_to_string(v_keys, '|')));
  end if;
  return v_new;
end $$;

create or replace function public.run_logist(p_shipment_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid; v_shipments integer := 0; v_new integer := 0;
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к поставкам или документам' using errcode = '42501';
  end if;
  if p_shipment_id is not null then
    if not exists (select 1 from public.shipments where id = p_shipment_id) then raise exception 'Поставка не найдена'; end if;
    v_new := private.logist_refresh(p_shipment_id);
    v_shipments := 1;
  else
    for v_id in select id from public.shipments where not is_locked and status not in ('closed', 'cancelled') order by created_at loop
      v_new := v_new + private.logist_refresh(v_id);
      v_shipments := v_shipments + 1;
    end loop;
  end if;
  return jsonb_build_object('shipments', v_shipments, 'new', v_new,
    'pending', (select count(*) from public.logist_proposals where status = 'pending' and (p_shipment_id is null or shipment_id = p_shipment_id)));
end $$;

-- A task due at the end of a working day in Almaty.
create or replace function private.business_task_due(p_day date)
returns timestamptz language sql immutable set search_path = '' as $$
  select (p_day + time '18:00') at time zone 'Asia/Almaty'
$$;

create or replace function public.accept_logist_proposal(p_proposal_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  p public.logist_proposals%rowtype;
  v_user uuid := (select auth.uid());
  v_today date := (now() at time zone 'Asia/Almaty')::date;
  v_assignee uuid;
  v_result jsonb;
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к поставкам или документам' using errcode = '42501';
  end if;
  select * into p from public.logist_proposals where id = p_proposal_id for update;
  if not found then raise exception 'Предложение не найдено'; end if;
  if p.status <> 'pending' then raise exception 'Предложение уже рассмотрено'; end if;
  if not (select private.has_permission(private.logist_kind_permission(p.kind))) then
    raise exception 'Недостаточно прав, чтобы принять это предложение' using errcode = '42501';
  end if;
  perform 1 from public.shipments where id = p.shipment_id for update;
  -- The situation may have changed since the proposal was made.
  if not exists (select 1 from private.logist_candidates(p.shipment_id, v_today) c where c.dedupe_key = p.dedupe_key)
     or exists (select 1 from public.shipments sh where sh.id = p.shipment_id and (sh.is_locked or sh.status in ('closed', 'cancelled', 'on_hold'))) then
    update public.logist_proposals set status = 'obsolete' where id = p.id;
    return jsonb_build_object('status', 'obsolete');
  end if;

  if p.kind = 'complete_stage' then
    perform public.change_shipment_stage_status((p.action ->> 'stage_run_id')::uuid, 'completed', null, null);
    v_result := jsonb_build_object('stage_run_id', p.action ->> 'stage_run_id');
  elsif p.kind = 'bind_document_vehicle' then
    perform public.assign_source_extraction_transport((p.action ->> 'extraction_id')::uuid, (p.action ->> 'transport_id')::uuid);
    v_result := jsonb_build_object('extraction_id', p.action ->> 'extraction_id', 'transport_id', p.action ->> 'transport_id');
  elsif p.kind = 'follow_up_task' then
    -- Only a manager assigns tasks to others; anyone else who accepts takes the task.
    v_assignee := nullif(p.action ->> 'assignee_user_id', '')::uuid;
    if v_assignee is null or (v_assignee <> v_user and not (select private.has_permission('tasks.manage')))
       or not private.is_active_employee(v_assignee) then
      v_assignee := v_user;
    end if;
    v_result := jsonb_build_object('task_id', public.create_task(
      p.action ->> 'task_title', v_assignee, private.business_task_due(v_today + 1), 'high',
      p.action ->> 'task_description', p.shipment_id, nullif(p.action ->> 'stage_run_id', '')::uuid),
      'assignee_user_id', v_assignee);
  end if;

  update public.logist_proposals set status = 'accepted', decided_by = v_user, decided_at = now(), result = v_result where id = p.id;
  -- Accepting may open the next step (the following stage).
  perform private.logist_refresh(p.shipment_id);
  return jsonb_build_object('status', 'accepted', 'result', v_result);
end $$;

create or replace function public.reject_logist_proposal(p_proposal_id uuid, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare p public.logist_proposals%rowtype; v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if not (select private.has_permission('shipments.view')) or not (select private.has_permission('documents.view')) then
    raise exception 'Нет доступа к поставкам или документам' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 500 then raise exception 'Комментарий не должен быть длиннее 500 символов'; end if;
  select * into p from public.logist_proposals where id = p_proposal_id for update;
  if not found then raise exception 'Предложение не найдено'; end if;
  if p.status <> 'pending' then raise exception 'Предложение уже рассмотрено'; end if;
  if not (select private.has_permission(private.logist_kind_permission(p.kind))) then
    raise exception 'Недостаточно прав, чтобы отклонить это предложение' using errcode = '42501';
  end if;
  update public.logist_proposals set status = 'rejected', decided_by = (select auth.uid()), decided_at = now(), decision_note = v_note
  where id = p.id;
end $$;

do $$ declare f text; begin
  foreach f in array array[
    'private.logist_kind_permission(text)', 'private.logist_day(date)', 'private.logist_candidates(uuid,date)',
    'private.logist_refresh(uuid)', 'private.business_task_due(date)'
  ] loop execute format('revoke all on function %s from public,anon,authenticated,service_role', f); end loop;
end $$;
revoke all on function public.run_logist(uuid) from public, anon, service_role;
revoke all on function public.accept_logist_proposal(uuid) from public, anon, service_role;
revoke all on function public.reject_logist_proposal(uuid, text) from public, anon, service_role;
grant execute on function public.run_logist(uuid), public.accept_logist_proposal(uuid), public.reject_logist_proposal(uuid, text) to authenticated;

comment on function public.run_logist(uuid) is 'Brings Logist proposals of one shipment (or of all active shipments) up to date';
comment on function public.accept_logist_proposal(uuid) is 'Accepts a Logist proposal: re-checks it and runs the action with the employee''s own rights';
comment on function public.reject_logist_proposal(uuid, text) is 'Rejects a Logist proposal; the same situation is not proposed again';
