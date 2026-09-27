-- Shipment tasks and notifications (migration 202609272200): RLS, status rules, manager
-- actions, audit, notification events and idempotent deadline generation.
-- Every statement runs as the role and user named in the comment; names are fictitious.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated, service_role;

create or replace function tests.expect_error(p_sql text, p_pattern text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'expected error "%" but statement succeeded: %', p_pattern, p_sql
    using errcode = 'P0099';
exception
  when sqlstate 'P0099' then raise;
  when others then
    if sqlerrm !~* p_pattern then
      raise exception 'expected error "%" but got "%" for: %', p_pattern, sqlerrm, p_sql
        using errcode = 'P0099';
    end if;
end;
$$;

create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;

-- Ids created during the test, by name.
create table if not exists tests.tn (name text primary key, id uuid not null);
create or replace function tests.tn_id(p_name text) returns uuid
language sql stable as $$ select id from tests.tn where name = p_name $$;
-- Notifications of one user, by type and entity (checked as postgres).
create or replace function tests.tn_count(p_user uuid, p_type text, p_entity uuid default null) returns integer
language sql stable as $$
  select count(*)::int from public.notifications
  where recipient_user_id = p_user and type = p_type and (p_entity is null or entity_id = p_entity)
$$;
grant select, insert on tests.tn to authenticated;
grant execute on all functions in schema tests to authenticated, service_role;

-- Fixtures (as postgres) ---------------------------------------------------------------
-- 1 director (tasks.manage), 2 senior logistics manager (tasks.manage),
-- 3 and 4 logistics specialists, 5 accountant, 6 specialist responsible for the shipment.

insert into auth.users (id, email, raw_user_meta_data) values
  ('d7000000-0000-4000-8000-000000000001', 'tn-director@test.local', '{"full_name":"Директор"}'),
  ('d7000000-0000-4000-8000-000000000002', 'tn-senior@test.local', '{"full_name":"Старший менеджер"}'),
  ('d7000000-0000-4000-8000-000000000003', 'tn-alpha@test.local', '{"full_name":"Специалист Альфа"}'),
  ('d7000000-0000-4000-8000-000000000004', 'tn-beta@test.local', '{"full_name":"Специалист Бета"}'),
  ('d7000000-0000-4000-8000-000000000005', 'tn-accountant@test.local', '{"full_name":"Бухгалтер"}'),
  ('d7000000-0000-4000-8000-000000000006', 'tn-owner@test.local', '{"full_name":"Ответственный за поставку"}');

insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values
  ('d7000000-0000-4000-8000-000000000001', 'director'),
  ('d7000000-0000-4000-8000-000000000002', 'senior_logistics_manager'),
  ('d7000000-0000-4000-8000-000000000003', 'logistics_specialist'),
  ('d7000000-0000-4000-8000-000000000004', 'logistics_specialist'),
  ('d7000000-0000-4000-8000-000000000005', 'accountant'),
  ('d7000000-0000-4000-8000-000000000006', 'logistics_specialist')
) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;

insert into public.counterparties (id, roles, legal_name, country) values
  ('d8000000-0000-4000-8000-000000000001', array['supplier', 'manufacturer'], 'TN Supplier Oy', 'FI');

insert into public.shipments (id, shipment_number, type, supplier_id, route_id, process_template_id, currency_id,
  destination_warehouse_id, responsible_user_id, created_by)
select 'd9000000-0000-4000-8000-000000000001', 'TN-2026-0001', 'import', 'd8000000-0000-4000-8000-000000000001',
  (select id from public.routes where origin_country = 'FI' and destination_country = 'KZ' limit 1),
  (select id from public.process_templates where code = 'import_eu_kz' and version = 1),
  (select id from public.currencies where code = 'EUR'),
  (select id from public.warehouses where code = 'AKT'),
  'd7000000-0000-4000-8000-000000000006', 'd7000000-0000-4000-8000-000000000001';

insert into public.shipment_stage_runs (id, shipment_id, stage_id, status, responsible_user_id)
select ('da000000-0000-4000-8000-00000000000' || n)::uuid, 'd9000000-0000-4000-8000-000000000001', s.id, 'in_progress',
  'd7000000-0000-4000-8000-000000000003'
from (values (1, 'documents_check'), (2, 'transport_preparation')) as v(n, code)
join public.shipment_stages s on s.code = v.code
  and s.process_template_id = (select id from public.process_templates where code = 'import_eu_kz' and version = 1);

-- 1. Privileges ------------------------------------------------------------------------

do $$
begin
  assert not has_function_privilege('anon', 'public.create_task(text, uuid, timestamptz, text, text, uuid, uuid)', 'execute'), 'anon creates no tasks';
  assert not has_function_privilege('anon', 'public.mark_all_notifications_read()', 'execute'), 'anon has no notifications';
  assert not has_function_privilege('authenticated', 'public.generate_deadline_notifications(timestamptz)', 'execute'),
    'the full deadline run is for the scheduler only';
  assert has_function_privilege('service_role', 'public.generate_deadline_notifications(timestamptz)', 'execute'), 'scheduler may run it';
  assert not has_table_privilege('authenticated', 'public.tasks', 'insert'), 'tasks are created through create_task';
  assert not has_table_privilege('authenticated', 'public.tasks', 'update'), 'tasks change through the RPCs';
  assert not has_table_privilege('authenticated', 'public.tasks', 'delete'), 'tasks are not deleted';
  assert not has_table_privilege('authenticated', 'public.notifications', 'insert'), 'notifications come from the database';
  assert not has_table_privilege('authenticated', 'public.notifications', 'update'), 'read state changes through the RPCs';
  assert (select prosecdef from pg_proc where oid = 'public.create_task(text, uuid, timestamptz, text, text, uuid, uuid)'::regprocedure),
    'create_task runs as definer';
  assert private.user_has_permission('d7000000-0000-4000-8000-000000000002', 'tasks.manage'), 'senior manager manages tasks';
  assert not private.user_has_permission('d7000000-0000-4000-8000-000000000003', 'tasks.manage'), 'specialists do not';
end;
$$;

-- 2. Creating and assigning ------------------------------------------------------------

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000001'); -- director
insert into tests.tn values ('t1', public.create_task('Проверить сертификаты', 'd7000000-0000-4000-8000-000000000003',
  now() + interval '3 days', 'high', 'Сверить с инвойсом', null, 'da000000-0000-4000-8000-000000000001'));
select tests.expect_error($$ select public.create_task('Прошлый срок', 'd7000000-0000-4000-8000-000000000003', now() - interval '1 day') $$,
  'в прошлом');
select tests.expect_error($$ select public.create_task('  ', 'd7000000-0000-4000-8000-000000000003') $$, 'от 1 до 200');

select tests.act_as('d7000000-0000-4000-8000-000000000003'); -- specialist Alpha
select tests.expect_error($$ select public.create_task('Чужая задача', 'd7000000-0000-4000-8000-000000000004') $$, 'только руководитель');
insert into tests.tn values ('t2', public.create_task('Своя задача', 'd7000000-0000-4000-8000-000000000003'));
select tests.expect_error($$
  insert into public.tasks (title, assignee_user_id, created_by) values ('Мимо RPC', 'd7000000-0000-4000-8000-000000000003', 'd7000000-0000-4000-8000-000000000003')
$$, 'permission denied');
select tests.expect_error($$ update public.tasks set due_at = now() + interval '9 days' $$, 'permission denied');
reset role;

do $$
declare
  v_task public.tasks%rowtype;
begin
  select * into v_task from public.tasks where id = tests.tn_id('t1');
  assert v_task.shipment_id = 'd9000000-0000-4000-8000-000000000001', 'shipment taken from the stage run';
  assert v_task.entity_type = 'shipment_stage_run' and v_task.entity_id = v_task.stage_run_id, 'entity follows the stage';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'task_assigned', tests.tn_id('t1')) = 1, 'assignee notified';
  assert (select shipment_id from public.notifications where entity_id = tests.tn_id('t1') and type = 'task_assigned')
    = 'd9000000-0000-4000-8000-000000000001', 'notification links the shipment';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'task_assigned', tests.tn_id('t2')) = 0, 'no notification for own task';
end;
$$;

-- 3. Visibility ------------------------------------------------------------------------

set role authenticated;
do $$
begin
  perform tests.act_as('d7000000-0000-4000-8000-000000000003');
  assert (select count(*) from public.tasks) = 2, 'assignee sees own tasks';
  perform tests.act_as('d7000000-0000-4000-8000-000000000004');
  assert (select count(*) from public.tasks) = 0, 'another specialist sees none';
  perform tests.act_as('d7000000-0000-4000-8000-000000000005');
  assert (select count(*) from public.tasks) = 0, 'tasks.view alone shows no foreign tasks';
  perform tests.act_as('d7000000-0000-4000-8000-000000000002');
  assert (select count(*) from public.tasks) = 2, 'a manager sees tasks of employees';
  perform tests.act_as('d7000000-0000-4000-8000-000000000006');
  assert (select count(*) from public.tasks) = 1 and exists (select 1 from public.tasks where id = tests.tn_id('t1')),
    'the shipment owner sees tasks of the shipment only';
end;
$$;

-- 4. Status rules ----------------------------------------------------------------------

select tests.act_as('d7000000-0000-4000-8000-000000000004'); -- Beta, not the assignee
select tests.expect_error($$ select public.set_task_status(tests.tn_id('t1'), 'in_progress') $$, 'Нельзя перевести');

select tests.act_as('d7000000-0000-4000-8000-000000000003'); -- Alpha, the assignee
select public.set_task_status(tests.tn_id('t1'), 'in_progress');
select tests.expect_error($$ select public.reassign_task(tests.tn_id('t1'), 'd7000000-0000-4000-8000-000000000004') $$, 'только руководитель');
select tests.expect_error($$ select public.change_task_due(tests.tn_id('t1'), now() + interval '9 days') $$, 'только руководитель');
select tests.expect_error($$ select public.set_task_status(tests.tn_id('t1'), 'cancelled') $$, 'Нельзя перевести');
select public.set_task_status(tests.tn_id('t1'), 'done');
select tests.expect_error($$ select public.set_task_status(tests.tn_id('t1'), 'open') $$, 'Нельзя перевести');
reset role;

do $$
declare
  v_task public.tasks%rowtype;
begin
  select * into v_task from public.tasks where id = tests.tn_id('t1');
  assert v_task.status = 'done' and v_task.started_at is not null and v_task.completed_at is not null, 'start and completion times';
end;
$$;

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000001'); -- director reopens and reassigns
select public.set_task_status(tests.tn_id('t1'), 'open');
select public.reassign_task(tests.tn_id('t1'), 'd7000000-0000-4000-8000-000000000004');
select tests.expect_error($$ select public.reassign_task(tests.tn_id('t1'), 'd7000000-0000-4000-8000-000000000004') $$, 'уже назначена');
select public.change_task_due(tests.tn_id('t1'), now() + interval '2 hours');
select tests.expect_error($$ select public.change_task_due(tests.tn_id('t1'), now() - interval '2 hours') $$, 'в прошлом');

select tests.act_as('d7000000-0000-4000-8000-000000000003'); -- Alpha no longer sees the task
do $$ begin assert not exists (select 1 from public.tasks where id = tests.tn_id('t1')), 'previous assignee loses access'; end $$;
reset role;

do $$
declare
  v_last public.audit_log%rowtype;
begin
  assert (select completed_at from public.tasks where id = tests.tn_id('t1')) is null, 'reopening clears completion';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000004', 'task_reassigned', tests.tn_id('t1')) = 1, 'new assignee notified';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'task_reassigned', tests.tn_id('t1')) = 1, 'previous assignee notified';
  assert (select count(*) from public.audit_log where entity_type = 'tasks' and entity_id = tests.tn_id('t1')::text) = 6,
    'create, start, complete, reopen, reassign and due change are audited';
  select * into v_last from public.audit_log where entity_type = 'tasks' and entity_id = tests.tn_id('t1')::text order by id desc limit 1;
  assert v_last.actor_user_id = 'd7000000-0000-4000-8000-000000000001' and v_last.action = 'update'
    and v_last.after_data ->> 'assignee_user_id' = 'd7000000-0000-4000-8000-000000000004', 'audit keeps actor and values';
end;
$$;

-- 5. Deadline notifications are idempotent -----------------------------------------------

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000001');
insert into tests.tn values ('t3', public.create_task('Позвонить перевозчику', 'd7000000-0000-4000-8000-000000000003', now() + interval '1 hour'));
reset role;
update public.tasks set due_at = now() - interval '1 hour' where id = tests.tn_id('t3'); -- overdue (as postgres)

set role service_role;
do $$
declare
  v_first integer := public.generate_deadline_notifications();
  v_second integer := public.generate_deadline_notifications();
begin
  -- t1 due in 2 h -> Beta; t3 overdue -> Alpha and its creator (director).
  assert v_first = 3, format('first run creates 3 notifications, got %s', v_first);
  assert v_second = 0, format('second run creates nothing, got %s', v_second);
end;
$$;
reset role;

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000003');
do $$ begin assert public.refresh_my_deadline_notifications() = 0, 'page refresh adds no duplicates'; end $$;
select tests.act_as('d7000000-0000-4000-8000-000000000001');
select public.change_task_due(tests.tn_id('t1'), now() + interval '3 hours');
reset role;

do $$
begin
  assert tests.tn_count('d7000000-0000-4000-8000-000000000004', 'deadline', tests.tn_id('t1')) = 1, 'one approaching notice';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'overdue', tests.tn_id('t3')) = 1, 'one overdue notice to the assignee';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000001', 'overdue', tests.tn_id('t3')) = 1, 'one overdue notice to the creator';
  assert (select count(*) from public.notifications where dedupe_key ~ '^task_(deadline|overdue):') = 3, 'nothing else generated';
end;
$$;

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000004');
do $$ begin assert public.refresh_my_deadline_notifications() = 1, 'a new due date is announced again'; end $$;
do $$ begin assert public.refresh_my_deadline_notifications() = 0, 'and only once'; end $$;
select tests.act_as('d7000000-0000-4000-8000-000000000003');
select public.set_task_status(tests.tn_id('t3'), 'done');
reset role;
set role service_role;
do $$ begin assert public.generate_deadline_notifications() = 0, 'completed tasks are not reported'; end $$;
reset role;

-- 6. Blocked stage ---------------------------------------------------------------------

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000003'); -- Alpha blocks the stage she owns
select public.change_shipment_stage_status('da000000-0000-4000-8000-000000000001', 'blocked', 'Нет сертификата происхождения');
reset role;

do $$
begin
  assert tests.tn_count('d7000000-0000-4000-8000-000000000006', 'stage_blocked', 'da000000-0000-4000-8000-000000000001') = 1,
    'shipment owner notified';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000004', 'stage_blocked', 'da000000-0000-4000-8000-000000000001') = 1,
    'assignee of an open task of the stage notified';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'stage_blocked') = 0, 'the employee who blocked it is not';
  assert (select body from public.notifications where type = 'stage_blocked' limit 1) ~ 'Нет сертификата происхождения', 'reason in the text';
end;
$$;

-- 7. Approvals -------------------------------------------------------------------------

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000003');
insert into public.approvals (entity_type, entity_id, approver_user_id, requested_by, request_comment)
values ('shipment', 'd9000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001',
        'd7000000-0000-4000-8000-000000000003', 'Прошу согласовать заказ');
insert into public.approvals (entity_type, entity_id, approver_role, requested_by)
values ('shipment', 'd9000000-0000-4000-8000-000000000001', 'senior_logistics_manager', 'd7000000-0000-4000-8000-000000000003');
select tests.act_as('d7000000-0000-4000-8000-000000000001');
update public.approvals set status = 'approved', decided_at = now(), comment = 'Согласовано'
where approver_user_id = 'd7000000-0000-4000-8000-000000000001' and status = 'pending';
reset role;
-- Document approvals name a permission instead of a user (as submit_document_for_review does).
insert into public.approvals (entity_type, entity_id, approver_role, requested_by)
values ('document', gen_random_uuid(), 'documents.approve', 'd7000000-0000-4000-8000-000000000003');

do $$
begin
  assert tests.tn_count('d7000000-0000-4000-8000-000000000001', 'approval_request', 'd9000000-0000-4000-8000-000000000001') = 1,
    'named approver notified';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000002', 'approval_request', 'd9000000-0000-4000-8000-000000000001') = 1,
    'holders of the approver role notified';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'approval_decision', 'd9000000-0000-4000-8000-000000000001') = 1,
    'requester learns the decision';
  assert (select title from public.notifications where type = 'approval_decision') ~ 'TN-2026-0001 — утверждено', 'decision text';
  -- Other test files leave directors behind; only this file's users are counted.
  assert (select count(*) from public.notifications n where n.type = 'approval_request' and n.entity_type = 'document'
          and n.recipient_user_id::text like 'd7000000-%') = 1
     and tests.tn_count('d7000000-0000-4000-8000-000000000001', 'approval_request') = 2,
    'a permission-based request reaches the holders of documents.approve only';
  assert tests.tn_count('d7000000-0000-4000-8000-000000000003', 'approval_request') = 0, 'the requester is not asked';
end;
$$;

-- 8. Notifications are private and marked read through the RPCs ---------------------------

set role authenticated;
select tests.act_as('d7000000-0000-4000-8000-000000000004'); -- Beta
do $$
declare
  v_foreign uuid;
begin
  assert (select count(*) from public.notifications) > 0, 'Beta has notifications';
  assert not exists (select 1 from public.notifications where recipient_user_id <> 'd7000000-0000-4000-8000-000000000004'),
    'only own notifications are visible';
  select id into v_foreign from tests.tn where name = 't1'; -- any id that is not Beta's notification
  perform tests.expect_error(format('select public.mark_notification_read(%L)', v_foreign), 'не найдено');
  perform public.mark_notification_read((select id from public.notifications order by created_at limit 1));
  assert (select count(*) from public.notifications where is_read) = 1, 'one marked read';
  assert public.mark_all_notifications_read() > 0, 'the rest marked read';
  assert not exists (select 1 from public.notifications where not is_read), 'nothing unread left';
end;
$$;
select tests.expect_error($$ update public.notifications set is_read = false $$, 'permission denied');
reset role;

do $$
begin
  assert exists (select 1 from public.notifications where recipient_user_id = 'd7000000-0000-4000-8000-000000000003' and not is_read),
    'other users keep their unread notifications';
end;
$$;

\echo 'tasks_notifications: all checks passed'
