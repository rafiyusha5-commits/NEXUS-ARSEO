-- Database security hardening after the audit of all migrations up to 202609272200
-- (docs/security-audit.md). Every section names the finding it closes (S1…S11); the
-- exploit and its closure are covered by supabase/tests/before/202609272300_database_security_hardening.sql
-- (runs on the schema before this migration and proves the bypass) and
-- supabase/tests/security_audit.test.sql (proves it is closed).
--
-- Idempotent: grants and revokes are repeatable, policies, triggers and functions are
-- dropped and re-created.

-- S1. No privileges for anon, no TRUNCATE/TRIGGER/REFERENCES for authenticated -------------
-- Supabase grants ALL on new objects in public to anon and authenticated by default, and
-- functions are executable by PUBLIC. The browser never needs anon data access: sign-in
-- goes through the Auth API.

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke truncate, trigger, references on all tables in schema public from authenticated;

-- Functions of the project (not of extensions): drop PUBLIC and anon, keep the existing
-- authenticated and service_role access. Trigger functions need no EXECUTE for firing.
do $$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid, p.oid::regprocedure as signature, p.prorettype = 'trigger'::regtype as is_trigger,
           has_function_privilege('authenticated', p.oid, 'execute') as for_authenticated,
           has_function_privilege('service_role', p.oid, 'execute') as for_service
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    execute format('revoke execute on function %s from public, anon', v_fn.signature);
    if v_fn.for_authenticated and not v_fn.is_trigger then
      execute format('grant execute on function %s to authenticated', v_fn.signature);
    end if;
    if v_fn.for_service and not v_fn.is_trigger then
      execute format('grant execute on function %s to service_role', v_fn.signature);
    end if;
  end loop;
end;
$$;

-- Objects created by later migrations (run as postgres) start without anon access.
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke execute on functions from anon;
-- The built-in EXECUTE for PUBLIC can only be removed globally, which would also hit
-- extensions installed later. Instead every migration revokes EXECUTE from public and anon
-- on its functions, and supabase/tests/security_audit.test.sql fails if one is missed.

-- S2. A self-registered account is not an employee -----------------------------------------
-- handle_new_user() creates every Auth user as an active 'employee'. With public sign-up
-- enabled in Supabase (the default), anybody holding the publishable key became an
-- employee and could read all active profiles, comments, process settings and create
-- approvals. An employee now also needs an enabled role or an active allow override —
-- invitations from /admin/users always assign a role.

create or replace function private.is_employee()
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.is_active
      and p.user_type = 'employee'
      and (
        exists (
          select 1
          from public.user_roles ur
          join public.app_roles r on r.id = ur.role_id
          where ur.user_id = p.id and r.is_enabled
            and (ur.expires_at is null or ur.expires_at > now())
        )
        or exists (
          select 1
          from public.user_permission_overrides o
          where o.user_id = p.id and o.effect = 'allow' and o.revoked_at is null
            and (o.expires_at is null or o.expires_at > now())
        )
      )
  );
$$;

-- Everybody can read their own profile (the app checks is_active from it).
drop policy if exists "employees view active profiles or user managers view all" on public.profiles;
create policy "employees view active profiles or user managers view all" on public.profiles
for select to authenticated
using (
  id = (select auth.uid())
  or (is_active and (select private.is_employee()))
  or (select private.has_permission('users.manage'))
);

-- Active personal deny of one permission for the signed-in user.
create or replace function private.has_active_deny(p_permission text)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select exists (
    select 1
    from public.user_permission_overrides o
    join public.permissions p on p.id = o.permission_id
    where o.user_id = (select auth.uid()) and p.code = p_permission and o.effect = 'deny'
      and o.revoked_at is null and (o.expires_at is null or o.expires_at > now())
  );
$$;
revoke execute on function private.has_active_deny(text) from public, anon;
grant execute on function private.has_active_deny(text) to authenticated;

-- S3. Audit log: no forged entries, no snapshots for non-auditors, deny wins ----------------
-- Any user could insert arbitrary audit events, read before/after snapshots of rows they
-- changed through SECURITY DEFINER functions (e.g. confidential product fields after a
-- reference import) and administrators/directors were matched by role, so a personal
-- deny of audit.view had no effect.

drop policy if exists "users append their own audit events" on public.audit_log;
create policy "users append their own audit events" on public.audit_log
for insert to authenticated
with check (
  actor_user_id = (select auth.uid())
  and (select private.is_employee())
  and action = 'download'
  and entity_type in ('documents', 'document_templates')
  and before_data is null
  and after_data is null
);

drop policy if exists "leaders view audit events" on public.audit_log;
create policy "leaders view audit events" on public.audit_log
for select to authenticated
using ((select private.has_permission('audit.view')));

revoke update, delete on public.audit_log from authenticated;

-- S4. Access managers can not lift or bypass their own personal restrictions -----------------
-- A holder of roles.manage could revoke a deny override imposed on themselves (or grant
-- themselves an allow), which made the deny meaningless. Own overrides are now managed by
-- another access manager only.

drop policy if exists "access managers grant overrides" on public.user_permission_overrides;
create policy "access managers grant overrides" on public.user_permission_overrides
for insert to authenticated
with check (
  (select private.has_permission('roles.manage'))
  and granted_by = (select auth.uid())
  and user_id <> (select auth.uid())
);

drop policy if exists "access managers revoke overrides" on public.user_permission_overrides;
create policy "access managers revoke overrides" on public.user_permission_overrides
for update to authenticated
using ((select private.has_permission('roles.manage')) and user_id <> (select auth.uid()))
with check ((select private.has_permission('roles.manage')) and user_id <> (select auth.uid()));

-- S5. Approvals: no forged decisions, deny wins, documents follow documents.view ------------
-- Any authenticated user (even without a role) could insert an approval that was already
-- 'approved' in the name of another approver, a named approver decided although their
-- personal deny of shipments.approve was active, approvers could rewrite requester and
-- subject, and document approvals stayed visible to requester and approver after a deny of
-- documents.view.

drop policy if exists "employees create approvals" on public.approvals;
create policy "employees create approvals" on public.approvals
for insert to authenticated
with check (
  entity_type <> 'document'
  and requested_by = (select auth.uid())
  and (select private.is_employee())
  and status = 'pending'
  and decided_at is null
  and comment is null
  and approver_user_id is distinct from (select auth.uid())
  and (entity_type <> 'shipment' or (select private.has_permission('shipments.view')))
);

drop policy if exists "employees view approvals" on public.approvals;
create policy "employees view approvals" on public.approvals
for select to authenticated
using (
  entity_type <> 'document'
  and (select private.is_employee())
  and (entity_type <> 'shipment' or (select private.has_permission('shipments.view')))
  and (
    requested_by = (select auth.uid())
    or approver_user_id = (select auth.uid())
    or (select private.has_permission('shipments.approve'))
  )
);

drop policy if exists "document participants view approvals" on public.approvals;
create policy "document participants view approvals" on public.approvals
for select to authenticated
using (entity_type = 'document' and (select private.has_permission('documents.view')));

drop policy if exists "approvers update approvals" on public.approvals;
create policy "approvers update approvals" on public.approvals
for update to authenticated
using (
  entity_type <> 'document'
  and (select private.is_employee())
  and (
    (select private.has_permission('shipments.approve'))
    or (approver_user_id = (select auth.uid()) and not (select private.has_active_deny('shipments.approve')))
  )
)
with check (
  entity_type <> 'document'
  and (
    (select private.has_permission('shipments.approve'))
    or (approver_user_id = (select auth.uid()) and not (select private.has_active_deny('shipments.approve')))
  )
);

-- Decisions change status and comment only; the rest is fixed at request time
-- (decided_at is accepted but always set by the trigger below).
revoke update on public.approvals from authenticated;
grant update (status, comment, decided_at) on public.approvals to authenticated;
revoke delete on public.approvals from authenticated;

-- A request is decided once: pending -> approved / rejected / cancelled. The deciding
-- employee and the time are recorded by the database.
create or replace function private.guard_approval_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status <> 'pending' then
    raise exception 'Запрос на согласование уже обработан';
  end if;
  if new.status not in ('approved', 'rejected', 'cancelled') then
    raise exception 'Недопустимое решение по согласованию';
  end if;
  new.decided_at := now();
  if new.approver_user_id is null then
    new.approver_user_id := (select auth.uid());
  end if;
  return new;
end;
$$;
revoke execute on function private.guard_approval_decision() from public, anon;

drop trigger if exists guard_approval_decision on public.approvals;
create trigger guard_approval_decision
  before update of status on public.approvals
  for each row execute function private.guard_approval_decision();

-- S6. Notifications follow the permission of the object they describe -------------------------
-- Only task notifications were hidden after a deny. Document and shipment notifications
-- (approval requests and decisions, blocked stages, task notifications carrying a shipment
-- number) stayed readable after a deny of documents.view / shipments.view and kept being
-- created.

create or replace function private.notification_visible_to(
  p_user uuid, p_entity_type text, p_shipment_id uuid)
returns boolean
language sql
security definer
set search_path = ''
stable
as $$
  select
    (p_entity_type is distinct from 'task' or private.user_has_permission(p_user, 'tasks.view'))
    and (p_entity_type is distinct from 'document' or private.user_has_permission(p_user, 'documents.view'))
    and ((p_shipment_id is null and p_entity_type is distinct from 'shipment' and p_entity_type is distinct from 'shipment_stage_run')
         or private.user_has_permission(p_user, 'shipments.view'));
$$;
revoke execute on function private.notification_visible_to(uuid, text, uuid) from public, anon;

drop policy if exists "users view own notifications" on public.notifications;
create policy "users view own notifications" on public.notifications for select to authenticated
using (
  recipient_user_id = (select auth.uid())
  and (entity_type is distinct from 'task' or (select private.has_permission('tasks.view')))
  and (entity_type is distinct from 'document' or (select private.has_permission('documents.view')))
  and ((shipment_id is null and entity_type is distinct from 'shipment' and entity_type is distinct from 'shipment_stage_run')
       or (select private.has_permission('shipments.view')))
);

create or replace function private.notify(
  p_recipient uuid, p_type text, p_title text, p_body text,
  p_entity_type text, p_entity_id uuid, p_shipment_id uuid, p_dedupe_key text default null)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_recipient is null or not private.is_active_employee(p_recipient) then
    return false;
  end if;
  if not private.notification_visible_to(p_recipient, p_entity_type, p_shipment_id) then
    return false;
  end if;
  insert into public.notifications (recipient_user_id, type, title, body, entity_type, entity_id, shipment_id, dedupe_key)
  values (p_recipient, p_type, left(p_title, 200), left(p_body, 1000), p_entity_type, p_entity_id, p_shipment_id, p_dedupe_key)
  on conflict (recipient_user_id, dedupe_key) where dedupe_key is not null do nothing;
  return found;
end;
$$;

create or replace function private.generate_deadline_notifications(
  p_user uuid, p_now timestamptz, p_window interval default interval '24 hours')
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  insert into public.notifications (recipient_user_id, type, title, body, entity_type, entity_id, shipment_id, dedupe_key)
  select c.recipient, c.kind, left(c.title, 200), c.body, 'task', c.id, c.shipment_id,
         'task_' || c.kind || ':' || c.id || ':' || extract(epoch from c.due_at)::bigint
  from (
    select t.id, t.shipment_id, t.due_at, t.assignee_user_id as recipient,
           case when t.due_at <= p_now then 'overdue' else 'deadline' end as kind,
           case when t.due_at <= p_now then 'Задача просрочена: ' else 'Срок задачи истекает: ' end || t.title as title,
           concat_ws('. ', case when t.due_at <= p_now then 'Срок был ' else 'Срок ' end || private.format_local_time(t.due_at),
             nullif(private.task_context(t), '')) as body
    from public.tasks t
    where t.status in ('open', 'in_progress') and t.due_at is not null and t.due_at <= p_now + p_window
    union all
    select t.id, t.shipment_id, t.due_at, t.created_by, 'overdue',
           'Просрочена задача сотрудника ' || coalesce(p.full_name, '—') || ': ' || t.title,
           'Срок был ' || private.format_local_time(t.due_at)
    from public.tasks t
    left join public.profiles p on p.id = t.assignee_user_id
    where t.status in ('open', 'in_progress') and t.due_at is not null and t.due_at <= p_now
      and t.created_by is not null and t.created_by <> t.assignee_user_id
  ) c
  where (p_user is null or c.recipient = p_user)
    and private.is_active_employee(c.recipient)
    and private.notification_visible_to(c.recipient, 'task', c.shipment_id)
  on conflict (recipient_user_id, dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same visibility as the read policy: hidden notifications are not touched.
  update public.notifications n set is_read = true, read_at = coalesce(n.read_at, now())
  where n.id = p_notification_id and n.recipient_user_id = (select auth.uid())
    and private.notification_visible_to(n.recipient_user_id, n.entity_type, n.shipment_id);
  if not found then
    raise exception 'Уведомление не найдено';
  end if;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if (select auth.uid()) is null then
    raise exception 'Требуется авторизация' using errcode = '42501';
  end if;
  update public.notifications n set is_read = true, read_at = now()
  where n.recipient_user_id = (select auth.uid()) and not n.is_read
    and private.notification_visible_to(n.recipient_user_id, n.entity_type, n.shipment_id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- S7. Shipments: status, lock and identity change only through the RPCs ---------------------
-- shipments.update allowed plain UPDATEs of every column: reopening a closed or cancelled
-- shipment, cancelling or holding it without a reason, changing number, type, process
-- template or author. Editable business fields stay writable while the shipment is active.

-- Shipments are created by create_shipment_with_stages only (a direct INSERT could create a
-- shipment that is already closed, without stages).
revoke insert on public.shipments from authenticated;
drop policy if exists "employees create shipments" on public.shipments;
revoke update on public.shipments from authenticated;
grant update (project_code, supplier_id, customer_id, route_id, contract_id, currency_id, incoterms,
  destination_warehouse_id, responsible_user_id, planned_ready_date, planned_arrival_date, updated_at)
  on public.shipments to authenticated;
revoke delete on public.shipments from authenticated;

drop policy if exists "employees update shipments" on public.shipments;
create policy "employees update shipments" on public.shipments for update to authenticated
using ((select private.has_permission('shipments.update')) and not is_locked and status not in ('closed', 'cancelled'))
with check ((select private.has_permission('shipments.update')) and not is_locked and status not in ('closed', 'cancelled'));

-- S8. Stage runs, stage history and transports: no direct writes --------------------------------
-- shipments.change_status allowed setting any stage status directly (no history, no reason,
-- no recalculation of the shipment), moving stage runs between shipments, and appending
-- forged history rows; shipments.update allowed arbitrary transport statuses, actual dates
-- and moving transports between shipments.

revoke insert, update, delete on public.shipment_stage_runs from authenticated;
revoke insert, update, delete on public.shipment_stage_history from authenticated;
revoke insert, update, delete on public.shipment_transports from authenticated;

drop policy if exists "employees create stage runs" on public.shipment_stage_runs;
drop policy if exists "employees update stage runs" on public.shipment_stage_runs;
drop policy if exists "employees append stage history" on public.shipment_stage_history;
drop policy if exists "employees create shipment transports" on public.shipment_transports;
drop policy if exists "employees update shipment transports" on public.shipment_transports;

-- The two shipment functions that wrote these tables as the caller now run as definer with
-- the same permission checks.
create or replace function public.create_shipment_with_stages(
  p_project_code text,p_type text,p_supplier_id uuid,p_customer_id uuid,p_route_id uuid,
  p_currency_id uuid,p_warehouse_id uuid,p_responsible_user_id uuid,p_planned_ready_date date default null,p_planned_arrival_date date default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare v_template uuid; v_shipment uuid; v_number text; v_year text;
begin
  if not (select private.has_permission('shipments.create')) then raise exception 'Недостаточно прав для создания поставки'; end if;
  if p_type not in ('import','export','domestic_transfer') then raise exception 'Некорректный тип поставки'; end if;
  if not private.is_active_employee(p_responsible_user_id) then raise exception 'Ответственный сотрудник не найден или неактивен'; end if;
  v_year := to_char(current_date,'YYYY');
  perform pg_advisory_xact_lock(hashtext('nexus_shipment_number_' || v_year));
  select id into v_template from public.process_templates where status='active' and is_default and (shipment_type=p_type or shipment_type is null) order by version desc limit 1;
  if v_template is null then raise exception 'Активный шаблон процесса не найден'; end if;
  select 'NAR-' || v_year || '-' || lpad((count(*)+1)::text,4,'0') into v_number from public.shipments where extract(year from created_at)=extract(year from current_date);
  insert into public.shipments(shipment_number,project_code,type,supplier_id,customer_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,planned_ready_date,planned_arrival_date,created_by)
  values(v_number,nullif(trim(p_project_code),''),p_type,p_supplier_id,p_customer_id,p_route_id,v_template,p_currency_id,p_warehouse_id,p_responsible_user_id,p_planned_ready_date,p_planned_arrival_date,(select auth.uid())) returning id into v_shipment;
  insert into public.shipment_stage_runs(shipment_id,stage_id,is_required,status,responsible_user_id,status_reason)
  select v_shipment,s.id,s.requirement='required',case when s.requirement='conditional' then 'not_applicable' else 'pending' end,p_responsible_user_id,
    case when s.requirement='conditional' then 'Будет активирован при выполнении условия' end
  from public.shipment_stages s where s.process_template_id=v_template and s.is_active;
  update public.shipments set leading_stage_id=(select id from public.shipment_stages where process_template_id=v_template and sequence_order=1) where id=v_shipment;
  return v_shipment;
end $$;

create or replace function public.change_shipment_stage_status(p_run_id uuid,p_status text,p_reason text default null,p_performed_by_name text default null)
returns void language plpgsql security definer set search_path='' as $$
declare v_old text; v_shipment uuid; v_locked boolean;
begin
  if not (select private.has_permission('shipments.change_status')) then raise exception 'Недостаточно прав'; end if;
  if p_status not in ('pending','in_progress','blocked','completed','skipped','not_applicable') then raise exception 'Некорректный статус этапа'; end if;
  if p_status in ('blocked','skipped','not_applicable') and nullif(trim(p_reason),'') is null then raise exception 'Укажите причину'; end if;
  select r.status,r.shipment_id,s.is_locked into v_old,v_shipment,v_locked from public.shipment_stage_runs r join public.shipments s on s.id=r.shipment_id where r.id=p_run_id for update of r;
  if not found then raise exception 'Этап поставки не найден'; end if;
  if v_locked then raise exception 'Закрытая поставка недоступна для изменений'; end if;
  update public.shipment_stage_runs set status=p_status,status_reason=nullif(trim(p_reason),''),performed_by_name=nullif(trim(p_performed_by_name),''),started_at=case when p_status='in_progress' then coalesce(started_at,now()) else started_at end,completed_at=case when p_status='completed' then now() else null end,updated_at=now() where id=p_run_id;
  insert into public.shipment_stage_history(stage_run_id,shipment_id,from_status,to_status,changed_by,performed_by_name,reason) values(p_run_id,v_shipment,v_old,p_status,(select auth.uid()),nullif(trim(p_performed_by_name),''),nullif(trim(p_reason),''));
  update public.shipments sh set
    leading_stage_id=(select r.stage_id from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id where r.shipment_id=v_shipment and r.is_required and r.status not in ('completed','skipped','not_applicable') order by st.sequence_order limit 1),
    status=coalesce((select st.status_category from public.shipment_stage_runs r join public.shipment_stages st on st.id=r.stage_id where r.shipment_id=v_shipment and r.is_required and r.status not in ('completed','skipped','not_applicable') order by st.sequence_order limit 1),'closed'),updated_at=now()
  where sh.id=v_shipment and sh.status not in ('on_hold','cancelled');
end $$;

-- Adding a vehicle used to write transports and stage runs from the application in several
-- statements; it is one transaction now.
create or replace function public.add_shipment_transport(
  p_shipment_id uuid,
  p_planned_loading_date date default null,
  p_planned_arrival_date date default null,
  p_temperature_setpoint text default null,
  p_notes text default null
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_sequence integer;
  v_transport uuid;
  v_first boolean;
begin
  if not (select private.has_permission('shipments.update')) then
    raise exception 'Недостаточно прав для добавления перевозки';
  end if;
  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if not found then raise exception 'Поставка не найдена'; end if;
  if v_shipment.is_locked or v_shipment.status in ('on_hold', 'cancelled', 'closed') then
    raise exception 'Поставка в статусе "%" недоступна для изменений', v_shipment.status;
  end if;
  if p_planned_loading_date is not null and p_planned_arrival_date is not null and p_planned_arrival_date < p_planned_loading_date then
    raise exception 'Плановое прибытие раньше плановой загрузки';
  end if;

  select coalesce(max(sequence_no), 0) + 1 into v_sequence from public.shipment_transports where shipment_id = p_shipment_id;
  v_first := v_sequence = 1;
  insert into public.shipment_transports (shipment_id, sequence_no, planned_loading_date, planned_arrival_date, temperature_setpoint, notes, status)
  values (p_shipment_id, v_sequence, p_planned_loading_date, p_planned_arrival_date,
          nullif(left(btrim(coalesce(p_temperature_setpoint, '')), 50), ''), nullif(left(btrim(coalesce(p_notes, '')), 500), ''), 'planned')
  returning id into v_transport;

  if v_first then
    -- The transport stages created with the shipment belong to the first vehicle.
    update public.shipment_stage_runs r set shipment_transport_id = v_transport, updated_at = now()
    from public.shipment_stages s
    where r.shipment_id = p_shipment_id and r.shipment_transport_id is null and s.id = r.stage_id
      and s.process_template_id = v_shipment.process_template_id and s.scope = 'transport' and s.is_active;
  else
    insert into public.shipment_stage_runs (shipment_id, stage_id, shipment_transport_id, is_required, status, responsible_user_id, status_reason)
    select p_shipment_id, s.id, v_transport, s.requirement = 'required',
           case when s.requirement = 'conditional' then 'not_applicable' else 'pending' end,
           v_shipment.responsible_user_id,
           case when s.requirement = 'conditional' then 'Будет активирован при выполнении условия' end
    from public.shipment_stages s
    where s.process_template_id = v_shipment.process_template_id and s.scope = 'transport' and s.is_active;
  end if;
  return v_sequence;
end;
$$;

revoke execute on function public.create_shipment_with_stages(text,text,uuid,uuid,uuid,uuid,uuid,uuid,date,date) from public, anon;
revoke execute on function public.change_shipment_stage_status(uuid,text,text,text) from public, anon;
revoke execute on function public.add_shipment_transport(uuid,date,date,text,text) from public, anon;
grant execute on function public.create_shipment_with_stages(text,text,uuid,uuid,uuid,uuid,uuid,uuid,date,date) to authenticated;
grant execute on function public.change_shipment_stage_status(uuid,text,text,text) to authenticated;
grant execute on function public.add_shipment_transport(uuid,date,date,text,text) to authenticated;

-- S9. Shipment items: receiving, allocation and discrepancy fields only through the RPCs -------
-- shipments.update allowed direct UPDATEs of received quantities, discrepancy acceptance in
-- another employee's name, allocation to vehicles and moving items between shipments.
-- New items keep their plain INSERT for the order fields; changes go through
-- update_shipment_item / allocate_shipment_item / delete_shipment_item.

revoke insert, update, delete on public.shipment_items from authenticated;
grant insert (id, shipment_id, product_id, uom, ordered_quantity, unit_price, currency_id) on public.shipment_items to authenticated;
drop policy if exists "employees update shipment items" on public.shipment_items;

-- Customs records stay on their shipment: every field but the shipment remains editable.
revoke update, delete on public.customs_clearances from authenticated;
grant update (shipment_transport_id, broker_id, country, declaration_number, status, submitted_at, cleared_at,
  customs_value, duties_amount, fees_amount, currency_id, updated_at) on public.customs_clearances to authenticated;

-- S10. set_task_status does not reveal tasks the caller can not see -------------------------
-- Any employee with tasks.view learned the status of an arbitrary task id from the error
-- message ("Нельзя перевести задачу из статуса «done»…").

create or replace function public.set_task_status(p_task_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_task public.tasks%rowtype;
  v_manager boolean := (select private.has_permission('tasks.manage'));
  v_assignee boolean;
begin
  if not (select private.has_permission('tasks.view')) then
    raise exception 'Нет доступа к задачам' using errcode = '42501';
  end if;
  select * into v_task from public.tasks where id = p_task_id for update;
  -- Same visibility as the tasks read policy.
  if not found or not (
    v_task.assignee_user_id = v_actor or v_task.created_by = v_actor or v_manager
    or (v_task.shipment_id is not null and exists (
      select 1 from public.shipments s where s.id = v_task.shipment_id and s.responsible_user_id = v_actor)
      and (select private.has_permission('shipments.view')))
  ) then
    raise exception 'Задача не найдена';
  end if;
  v_assignee := v_task.assignee_user_id = v_actor;
  if not (
    (v_assignee and v_task.status = 'open' and p_status = 'in_progress')
    or (v_assignee and v_task.status in ('open', 'in_progress') and p_status = 'done')
    or (v_assignee and v_task.status = 'in_progress' and p_status = 'open')
    or ((v_manager or v_task.created_by = v_actor) and v_task.status in ('open', 'in_progress') and p_status = 'cancelled')
    or (v_manager and v_task.status in ('done', 'cancelled') and p_status = 'open')
  ) then
    raise exception 'Нельзя перевести задачу из статуса «%» в «%»', v_task.status, p_status using errcode = '42501';
  end if;
  update public.tasks set
    status = p_status,
    started_at = case when p_status = 'in_progress' then coalesce(started_at, now()) else started_at end,
    completed_at = case when p_status in ('done', 'cancelled') then now() else null end,
    updated_at = now()
  where id = p_task_id;
end;
$$;
revoke execute on function public.set_task_status(uuid, text) from public, anon;
grant execute on function public.set_task_status(uuid, text) to authenticated;

-- S11. Stored functions of this migration: no PUBLIC or anon EXECUTE ---------------------------
revoke execute on function private.is_employee() from public, anon;
grant execute on function private.is_employee() to authenticated;
revoke execute on function private.notify(uuid, text, text, text, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.generate_deadline_notifications(uuid, timestamptz, interval) from public, anon, authenticated;
revoke execute on function public.mark_notification_read(uuid) from public, anon;
revoke execute on function public.mark_all_notifications_read() from public, anon;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

comment on function public.add_shipment_transport(uuid,date,date,text,text) is
  'Adds a vehicle to an active shipment and links or creates its transport stages in one transaction';
