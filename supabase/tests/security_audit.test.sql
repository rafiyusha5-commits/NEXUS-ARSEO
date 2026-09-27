-- Database security audit (docs/security-audit.md), after 202609272300_database_security_hardening.sql.
-- The same scenarios run in supabase/tests/before/202609272300_database_security_hardening.sql on the
-- schema before the fix and succeed there; here every bypass must fail, and the legitimate
-- flows next to it must keep working. Sections S1…S11 match the migration.

\set ON_ERROR_STOP 1

\ir security/fixtures.sql

-- S1. anon has nothing; authenticated can not TRUNCATE ----------------------------------------
do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
      and has_function_privilege('anon', p.oid, 'execute')
  ), 'S1: no project function is executable by anon';
  assert not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'v', 'm', 'p')
      and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('anon', c.oid, 'insert')
           or has_table_privilege('anon', c.oid, 'update') or has_table_privilege('anon', c.oid, 'delete'))
  ), 'S1: anon has no table privileges';
  assert not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
      and (has_table_privilege('authenticated', c.oid, 'truncate') or has_table_privilege('authenticated', c.oid, 'trigger'))
  ), 'S1: authenticated can not TRUNCATE or create triggers';
  assert not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
  ), 'S1: row level security is enabled on every table';
  assert has_function_privilege('authenticated', 'public.allocate_shipment_item(uuid, uuid, numeric)', 'execute'),
    'S1: employees keep their RPCs';
  assert has_function_privilege('service_role', 'public.generate_deadline_notifications(timestamptz)', 'execute'),
    'S1: the scheduler keeps its RPC';
  assert not has_function_privilege('authenticated', 'private.notify(uuid, text, text, text, text, uuid, uuid, text)', 'execute'),
    'S1: notifications can not be written by employees';
end;
$$;

-- Every SECURITY DEFINER function pins an empty search_path.
do $$
begin
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prosecdef
      and not coalesce(p.proconfig, '{}') @> array['search_path=""']
  ), 'every SECURITY DEFINER function sets search_path = ''''';
end;
$$;

set role authenticated;

-- S2. An account without a role is not an employee ---------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000005');
do $$
begin
  assert not (select private.is_employee()), 'S2: no role, no employee';
  assert (select count(*) from public.profiles) = 1
     and exists (select 1 from public.profiles where id = '9a000000-0000-4000-8000-000000000005'),
    'S2: only the own profile is visible (the app still sees is_active)';
  assert (select count(*) from public.comments) = 0 and (select count(*) from public.process_templates) = 0,
    'S2: no employee-wide data';
  perform tests.expect_error($q$insert into public.comments (entity_type, entity_id, author_user_id, body)
    values ('shipment', '9b000000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000005', 'спам')$q$,
    'row-level security');
end;
$$;

-- S3a. No forged audit events; the download event of the application still works -------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
select tests.expect_error($$
  insert into public.audit_log (actor_user_id, action, entity_type, entity_id, after_data)
  values ('9a000000-0000-4000-8000-000000000003', 'update', 'products', '9b000000-0000-4000-8000-000000000011',
          '{"base_purchase_price": 1}')
$$, 'row-level security');
do $$
begin
  assert tests.affected($q$insert into public.audit_log (actor_user_id, action, entity_type, entity_id, metadata)
    values ('9a000000-0000-4000-8000-000000000003', 'download', 'documents', '9b000000-0000-4000-8000-000000000099',
            '{"source": "ui", "version": 1}')$q$) = 1, 'S3a: the document download event is still recorded';
end;
$$;

-- S3b. Audit snapshots are for auditors only ------------------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000007'); -- importer, products.view denied
select public.import_reference_data((select payload from tests.sec_package), false);
do $$
begin
  assert (select count(*) from public.audit_log) = 0, 'S3b: the importer reads no audit rows, so no purchase price';
end;
$$;

-- S3c. A personal deny of audit.view works for a director; the administrator keeps the log ------------
select tests.act_as('9a000000-0000-4000-8000-000000000002');
do $$ begin assert (select count(*) from public.audit_log) = 0, 'S3c: denied director reads nothing'; end $$;
select tests.act_as('9a000000-0000-4000-8000-000000000001');
do $$
begin
  assert exists (select 1 from public.audit_log where entity_type = 'products'
                 and (before_data ->> 'base_purchase_price')::numeric = 123.45), 'S3c: the administrator keeps the full log';
end;
$$;

-- S4. Own overrides are managed by someone else -------------------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000002');
do $$
begin
  assert tests.affected($q$update public.user_permission_overrides
    set revoked_at = now(), revoked_by = '9a000000-0000-4000-8000-000000000002'
    where user_id = '9a000000-0000-4000-8000-000000000002'$q$) = 0, 'S4: the director can not lift the own deny';
  perform tests.expect_error($q$insert into public.user_permission_overrides (user_id, permission_id, effect, reason, granted_by)
    select '9a000000-0000-4000-8000-000000000002', id, 'allow', 'self', '9a000000-0000-4000-8000-000000000002'
    from public.permissions where code = 'audit.view'$q$, 'row-level security');
  assert not exists (select 1 from public.user_permission_overrides
                     where user_id = '9a000000-0000-4000-8000-000000000002' and revoked_at is not null), 'S4: the deny stays';
end;
$$;

-- S5c. Requester and subject of a request are fixed ---------------------------------------------------
select tests.expect_error($$
  update public.approvals set requested_by = '9a000000-0000-4000-8000-000000000002',
    entity_id = '9b000000-0000-4000-8000-000000000022' where id = '9b000000-0000-4000-8000-000000000072'
$$, 'permission denied');

-- S5b. A personal deny of shipments.approve stops a named approver ------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000004');
do $$
begin
  assert tests.affected($q$update public.approvals set status = 'approved'
    where id = '9b000000-0000-4000-8000-000000000072'$q$) = 0, 'S5b: denied approver can not decide';
end;
$$;

-- S5a. Only pending requests can be created; a decision is recorded by the database -------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
select tests.expect_error($$
  insert into public.approvals (entity_type, entity_id, approver_user_id, requested_by, status, decided_at, comment)
  values ('shipment', '9b000000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000002',
          '9a000000-0000-4000-8000-000000000003', 'approved', now(), 'Согласовано')
$$, 'row-level security');
insert into public.approvals (id, entity_type, entity_id, approver_user_id, requested_by)
values ('9b000000-0000-4000-8000-000000000073', 'shipment', '9b000000-0000-4000-8000-000000000021',
        '9a000000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000003');
select tests.act_as('9a000000-0000-4000-8000-000000000002'); -- the director decides
update public.approvals set status = 'approved', decided_at = timestamptz '2000-01-01', comment = 'Согласовано'
where id = '9b000000-0000-4000-8000-000000000073';
select tests.expect_error($$
  update public.approvals set status = 'rejected' where id = '9b000000-0000-4000-8000-000000000073'
$$, 'уже обработан');
reset role;
do $$
begin
  assert (select decided_at > now() - interval '1 minute' from public.approvals where id = '9b000000-0000-4000-8000-000000000073'),
    'S5a: the decision time can not be backdated';
end;
$$;
set role authenticated;

-- S5d. An account without a role creates no requests ------------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000005');
select tests.expect_error($$
  insert into public.approvals (entity_type, entity_id, approver_user_id, requested_by)
  values ('shipment', '9b000000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000002',
          '9a000000-0000-4000-8000-000000000005')
$$, 'row-level security');

-- S5e / S6a. A deny of documents.view hides document approvals and notifications ---------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
do $$
begin
  assert not exists (select 1 from public.approvals where id = '9b000000-0000-4000-8000-000000000071'), 'S5e: document approval hidden';
  assert not exists (select 1 from public.notifications where id = '9b000000-0000-4000-8000-000000000081'), 'S6a: document notification hidden';
  perform tests.expect_error($q$select public.mark_notification_read('9b000000-0000-4000-8000-000000000081')$q$, 'не найдено');
  assert exists (select 1 from public.approvals where id = '9b000000-0000-4000-8000-000000000072'),
    'S5e: shipment requests of the same employee stay visible';
end;
$$;
select tests.act_as('9a000000-0000-4000-8000-000000000001');
do $$ begin assert exists (select 1 from public.approvals where id = '9b000000-0000-4000-8000-000000000071'), 'S5e: document viewers see it'; end $$;

-- S6b. A deny of shipments.view hides shipment notifications ------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000006');
do $$
begin
  assert not exists (select 1 from public.notifications where id = '9b000000-0000-4000-8000-000000000082'), 'S6b: shipment notification hidden';
  assert not exists (select 1 from public.approvals where id = '9b000000-0000-4000-8000-000000000074'), 'S5g: own shipment request hidden';
  assert (select count(*) from public.notifications where not is_read) = 0, 'S6b: the unread counter follows the policy';
end;
$$;
reset role;

-- S6c. No new notifications for employees without the object permission ------------------------------
do $$
begin
  assert not private.notify('9a000000-0000-4000-8000-000000000006', 'stage_blocked', 'Этап заблокирован', null,
    'shipment_stage_run', '9b000000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000021'),
    'S6c: no shipment notification for Viewer';
  assert not private.notify('9a000000-0000-4000-8000-000000000003', 'approval_decision', 'Документ согласован', null,
    'document', '9b000000-0000-4000-8000-000000000099', null),
    'S6c: no document notification for Spec';
  assert private.notify('9a000000-0000-4000-8000-000000000003', 'stage_blocked', 'Этап заблокирован', null,
    'shipment_stage_run', '9b000000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000021'),
    'S6c: employees with shipments.view keep receiving shipment notifications';
end;
$$;
set role authenticated;

-- S8a–c, S9. Stage runs, history, transports and items change only through the RPCs -------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
select tests.expect_error($$
  update public.shipment_stage_runs set status = 'completed' where id = '9b000000-0000-4000-8000-000000000031'
$$, 'permission denied');
select tests.expect_error($$
  insert into public.shipment_stage_history (stage_run_id, shipment_id, from_status, to_status, changed_by, reason)
  values ('9b000000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000021', 'blocked', 'completed',
          '9a000000-0000-4000-8000-000000000003', 'подделка')
$$, 'permission denied');
select tests.expect_error($$
  update public.shipment_transports set status = 'arrived', actual_arrival_date = date '2000-01-01'
  where id = '9b000000-0000-4000-8000-000000000041'
$$, 'permission denied');
select tests.expect_error($$
  update public.shipment_items set received_quantity = 100, discrepancy_accepted_by = '9a000000-0000-4000-8000-000000000002'
  where id = '9b000000-0000-4000-8000-000000000051'
$$, 'permission denied');
select tests.expect_error($$
  update public.customs_clearances set shipment_id = '9b000000-0000-4000-8000-000000000022'
  where id = '9b000000-0000-4000-8000-000000000052'
$$, 'permission denied');
do $$
begin
  assert tests.affected($q$update public.customs_clearances set declaration_number = 'DT-1'
    where id = '9b000000-0000-4000-8000-000000000052'$q$) = 1, 'S9b: customs fields stay editable';
end;
$$;
select tests.expect_error($$
  insert into public.shipment_items (shipment_id, product_id, ordered_quantity, received_quantity)
  values ('9b000000-0000-4000-8000-000000000021', '9b000000-0000-4000-8000-000000000011', 1, 1)
$$, 'permission denied');
-- The RPCs keep working.
select public.change_shipment_stage_status('9b000000-0000-4000-8000-000000000031', 'in_progress');
select public.update_shipment_item('9b000000-0000-4000-8000-000000000051', 90, 9.99);
do $$
begin
  assert public.add_shipment_transport('9b000000-0000-4000-8000-000000000021', current_date, current_date + 10) = 2,
    'add_shipment_transport numbers the second vehicle';
  assert exists (select 1 from public.shipment_stage_runs r join public.shipment_transports t on t.id = r.shipment_transport_id
                 where t.shipment_id = '9b000000-0000-4000-8000-000000000021' and t.sequence_no = 2),
    'the second vehicle gets its transport stages';
  assert exists (select 1 from public.shipment_stage_history where stage_run_id = '9b000000-0000-4000-8000-000000000031'
                 and to_status = 'in_progress' and changed_by = '9a000000-0000-4000-8000-000000000003'),
    'the stage RPC writes history in the caller''s name';
  assert (select ordered_quantity from public.shipment_items where id = '9b000000-0000-4000-8000-000000000051') = 90,
    'items change through update_shipment_item';
end;
$$;

-- S10. set_task_status does not reveal foreign tasks -------------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000004');
select tests.expect_error($$ select public.set_task_status('9b000000-0000-4000-8000-000000000061', 'open') $$, 'Задача не найдена');
select tests.act_as('9a000000-0000-4000-8000-000000000003'); -- the assignee still gets the rule message
select tests.expect_error($$ select public.set_task_status('9b000000-0000-4000-8000-000000000061', 'open') $$, 'Нельзя перевести');

-- S7a–b. Shipment status and lock change only through the RPCs ---------------------------------------
select tests.expect_error($$
  update public.shipments set status = 'planning' where id = '9b000000-0000-4000-8000-000000000022'
$$, 'permission denied');
select tests.expect_error($$
  update public.shipments set status = 'cancelled' where id = '9b000000-0000-4000-8000-000000000021'
$$, 'permission denied');
select tests.expect_error($$
  insert into public.shipments (shipment_number, type, supplier_id, route_id, process_template_id,
    currency_id, destination_warehouse_id, responsible_user_id, created_by, status, is_locked)
  select 'FAKE-0001', 'import', supplier_id, route_id, process_template_id, currency_id, destination_warehouse_id,
    responsible_user_id, '9a000000-0000-4000-8000-000000000003', 'closed', true
  from public.shipments where id = '9b000000-0000-4000-8000-000000000022'
$$, 'permission denied');
select tests.expect_error($$
  update public.shipments set is_locked = false, created_by = '9a000000-0000-4000-8000-000000000003'
  where id = '9b000000-0000-4000-8000-000000000021'
$$, 'permission denied');
do $$
begin
  assert tests.affected($q$update public.shipments set planned_arrival_date = current_date + 30
    where id = '9b000000-0000-4000-8000-000000000021'$q$) = 1, 'S7: business fields of an active shipment stay editable';
  assert tests.affected($q$update public.shipments set planned_arrival_date = current_date + 30
    where id = '9b000000-0000-4000-8000-000000000022'$q$) = 0, 'S7: a closed shipment is not editable';
end;
$$;
select public.change_shipment_operational_state('9b000000-0000-4000-8000-000000000021', 'hold', 'Ожидание документов');
select tests.expect_error($$
  select public.change_shipment_operational_state('9b000000-0000-4000-8000-000000000021', 'cancel', ' ')
$$, 'Укажите причину');
reset role;

-- S4 (continued). Another access manager lifts the director's deny --------------------------------
set role authenticated;
select tests.act_as('9a000000-0000-4000-8000-000000000001');
do $$
begin
  assert tests.affected($q$update public.user_permission_overrides
    set revoked_at = now(), revoked_by = '9a000000-0000-4000-8000-000000000001'
    where user_id = '9a000000-0000-4000-8000-000000000002' and revoked_at is null$q$) = 1, 'S4: the administrator can lift it';
end;
$$;
select tests.act_as('9a000000-0000-4000-8000-000000000002');
do $$ begin assert (select count(*) from public.audit_log) > 0, 'S3c: without the deny the director reads the log again'; end $$;
reset role;

-- S11 (a personal deny beats the role in every module) is checked last, in
-- zz_personal_deny_matrix.test.sql, when every module table holds data.

\echo 'security_audit: all checks passed'
