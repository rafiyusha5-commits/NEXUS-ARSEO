-- Runs on the schema BEFORE 202609272300_database_security_hardening.sql (scripts/test-db.sh
-- executes supabase/tests/before/<migration>.sql right before that migration) and proves
-- that every access bypass closed by it was real. Everything is rolled back.
-- supabase/tests/security_audit.test.sql proves the same scenarios are closed afterwards.

\set ON_ERROR_STOP 1
begin;

\ir ../security/fixtures.sql

-- S1. anon may execute definer RPCs; authenticated may TRUNCATE ------------------------------
do $$
begin
  assert has_function_privilege('anon', 'public.allocate_shipment_item(uuid, uuid, numeric)', 'execute'), 'S1: anon executes a definer RPC';
  assert has_function_privilege('anon', 'public.create_shipment_with_stages(text,text,uuid,uuid,uuid,uuid,uuid,uuid,date,date)', 'execute'), 'S1: anon executes create_shipment_with_stages';
  assert has_table_privilege('anon', 'public.shipments', 'select'), 'S1: anon holds table privileges';
  assert has_table_privilege('authenticated', 'public.shipments', 'truncate'), 'S1: authenticated may TRUNCATE';
  assert has_function_privilege('authenticated', 'private.protect_last_administrator_role()', 'execute'),
    'S1: authenticated executes a trigger function (through PUBLIC)';
  assert has_function_privilege('authenticated', 'private.has_role(text)', 'execute'),
    'S1: authenticated executes an internal helper outside any allowlist';
end;
$$;

set role authenticated;

-- S2. A self-registered account without roles is an employee -----------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000005');
do $$
begin
  assert (select private.is_employee()), 'S2: account without roles counts as employee';
  assert (select count(*) from public.profiles) > 1, 'S2: it reads the profiles of other employees';
  assert tests.affected($q$insert into public.comments (entity_type, entity_id, author_user_id, body)
    values ('shipment', '9b000000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000005', 'спам')$q$) = 1,
    'S2: it writes comments';
end;
$$;

-- S3a. Anybody forges audit events ----------------------------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
do $$
begin
  assert tests.affected($q$insert into public.audit_log (actor_user_id, action, entity_type, entity_id, after_data)
    values ('9a000000-0000-4000-8000-000000000003', 'update', 'products', '9b000000-0000-4000-8000-000000000011',
            '{"base_purchase_price": 1}')$q$) = 1, 'S3a: forged audit event accepted';
end;
$$;

-- S3b. Own audit rows reveal data the actor may not see ----------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000007'); -- importer, products.view denied
select public.import_reference_data((select payload from tests.sec_package), false);
do $$
begin
  assert not exists (select 1 from public.products where internal_sku = 'SEC-001'), 'S3b: products are hidden from the importer';
  assert exists (select 1 from public.audit_log where entity_type = 'products'
                 and (before_data ->> 'base_purchase_price')::numeric = 123.45),
    'S3b: the purchase price leaks through the audit snapshot';
end;
$$;

-- S3c. A personal deny of audit.view does not stop a director ------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000002');
do $$
begin
  assert (select count(*) from public.audit_log where actor_user_id is distinct from '9a000000-0000-4000-8000-000000000002') > 0,
    'S3c: director with a deny still reads the audit log';
end;
$$;

-- S4. An access manager lifts the deny imposed on themselves -------------------------------------
do $$
begin
  assert tests.affected($q$update public.user_permission_overrides
    set revoked_at = now(), revoked_by = '9a000000-0000-4000-8000-000000000002'
    where user_id = '9a000000-0000-4000-8000-000000000002'$q$) = 1, 'S4: own deny revoked by its holder';
end;
$$;

-- S5c. An approver rewrites requester and subject of a request -----------------------------------
do $$
begin
  assert tests.affected($q$update public.approvals set requested_by = '9a000000-0000-4000-8000-000000000002',
    entity_id = '9b000000-0000-4000-8000-000000000022' where id = '9b000000-0000-4000-8000-000000000072'$q$) = 1,
    'S5c: requester and subject rewritten';
end;
$$;

-- S5b. A named approver decides despite a personal deny of shipments.approve --------------------
select tests.act_as('9a000000-0000-4000-8000-000000000004');
do $$
begin
  assert tests.affected($q$update public.approvals set status = 'approved'
    where id = '9b000000-0000-4000-8000-000000000072'$q$) = 1, 'S5b: denied approver decided';
end;
$$;

-- S5f. A decision is rewritten afterwards, a pending request gets a comment without a decision ------
select tests.act_as('9a000000-0000-4000-8000-000000000002'); -- director, shipments.approve
do $$
begin
  assert tests.affected($q$update public.approvals set comment = 'Переписано задним числом', decided_at = timestamptz '2000-01-01'
    where id = '9b000000-0000-4000-8000-000000000072'$q$) = 1, 'S5f: decided approval rewritten (comment and time)';
  assert tests.affected($q$update public.approvals set comment = 'Без решения'
    where id = '9b000000-0000-4000-8000-000000000074'$q$) = 1, 'S5f: pending request commented without a decision';
end;
$$;

-- S5a. A requester inserts an already approved decision in the director's name ----------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
do $$
begin
  assert tests.affected($q$insert into public.approvals (entity_type, entity_id, approver_user_id, requested_by, status, decided_at, comment)
    values ('shipment', '9b000000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000002',
            '9a000000-0000-4000-8000-000000000003', 'approved', now(), 'Согласовано')$q$) = 1, 'S5a: forged approval accepted';
end;
$$;

-- S5d. An account without a role creates approval requests ------------------------------------------
select tests.act_as('9a000000-0000-4000-8000-000000000005');
do $$
begin
  assert tests.affected($q$insert into public.approvals (entity_type, entity_id, approver_user_id, requested_by)
    values ('shipment', '9b000000-0000-4000-8000-000000000021', '9a000000-0000-4000-8000-000000000002',
            '9a000000-0000-4000-8000-000000000005')$q$) = 1, 'S5d: request by a non-employee accepted';
end;
$$;

-- S5e / S6a. Document approvals and notifications stay visible after a deny of documents.view ------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
do $$
begin
  assert exists (select 1 from public.approvals where id = '9b000000-0000-4000-8000-000000000071'), 'S5e: document approval visible';
  assert exists (select 1 from public.notifications where id = '9b000000-0000-4000-8000-000000000081'), 'S6a: document notification visible';
end;
$$;

-- S6b / S5g. Shipment notifications and requests stay visible after a deny of shipments.view ------
select tests.act_as('9a000000-0000-4000-8000-000000000006');
do $$
begin
  assert exists (select 1 from public.notifications where id = '9b000000-0000-4000-8000-000000000082'), 'S6b: shipment notification visible';
  assert exists (select 1 from public.approvals where id = '9b000000-0000-4000-8000-000000000074'), 'S5g: own shipment request visible';
end;
$$;

-- S8a–c, S9. Stage runs, history, transports and items are written directly --------------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
do $$
begin
  assert tests.affected($q$update public.shipment_stage_runs set status = 'completed', completed_at = now()
    where id = '9b000000-0000-4000-8000-000000000031'$q$) = 1, 'S8a: stage completed without the RPC';
  assert not exists (select 1 from public.shipment_stage_history where stage_run_id = '9b000000-0000-4000-8000-000000000031'),
    'S8a: and without history';
  assert tests.affected($q$insert into public.shipment_stage_history (stage_run_id, shipment_id, from_status, to_status, changed_by, reason)
    values ('9b000000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000021', 'blocked', 'completed',
            '9a000000-0000-4000-8000-000000000003', 'подделка')$q$) = 1, 'S8b: forged history row accepted';
  assert tests.affected($q$update public.shipment_transports set status = 'arrived', actual_arrival_date = date '2000-01-01'
    where id = '9b000000-0000-4000-8000-000000000041'$q$) = 1, 'S8c: transport status and dates written directly';
  assert tests.affected($q$update public.shipment_items set received_quantity = 100,
    discrepancy_accepted_by = '9a000000-0000-4000-8000-000000000002'
    where id = '9b000000-0000-4000-8000-000000000051'$q$) = 1, 'S9: receipt accepted in the director''s name';
  assert tests.affected($q$update public.customs_clearances set shipment_id = '9b000000-0000-4000-8000-000000000022'
    where id = '9b000000-0000-4000-8000-000000000052'$q$) = 1, 'S9b: customs record moved to another shipment';
end;
$$;

-- S10. set_task_status reveals the status of a task the caller can not see ----------------------
select tests.act_as('9a000000-0000-4000-8000-000000000004');
select tests.expect_error($$ select public.set_task_status('9b000000-0000-4000-8000-000000000061', 'open') $$, '«done»');

-- S12. A personal deny of shipments.view does not stop the shipment RPCs --------------------------
-- Blind: the role grants shipments.update / change_status / inventory.receive, shipments.view is
-- denied. The shipment is invisible, but with its UUID every write RPC works.
select tests.act_as('9a000000-0000-4000-8000-000000000009');
do $$
declare
  v_id uuid;
begin
  assert not exists (select 1 from public.shipments where id = '9b000000-0000-4000-8000-000000000021'), 'S12: Blind can not read the shipment';
  perform public.update_shipment_item('9b000000-0000-4000-8000-000000000051', 80, 0.01);
  perform public.change_shipment_transport_status('9b000000-0000-4000-8000-000000000041', 'loading');
  v_id := public.receive_inventory_batch('9b000000-0000-4000-8000-000000000051',
    (select id from public.warehouses where code = 'AKT'), null, 'BLIND-1', null, current_date + 100, 1, null);
  assert v_id is not null, 'S12: goods received against an invisible shipment item';
  -- create_shipment_with_stages was a caller-rights function before the fix: its INSERT ...
  -- RETURNING needed the SELECT policy, so creation was already refused. Checked after the fix.
  perform public.change_shipment_operational_state('9b000000-0000-4000-8000-000000000021', 'hold', 'Blind');
end;
$$;
reset role;
do $$
begin
  assert (select unit_price = 0.01 and ordered_quantity = 80 from public.shipment_items where id = '9b000000-0000-4000-8000-000000000051'),
    'S12: quantity and price of an invisible item changed';
  assert (select status = 'on_hold' from public.shipments where id = '9b000000-0000-4000-8000-000000000021'),
    'S12: invisible shipment put on hold';
end;
$$;
set role authenticated;

-- S7a–b. Shipment status changed directly: reopen a closed one, cancel without a reason ------------
select tests.act_as('9a000000-0000-4000-8000-000000000003');
do $$
begin
  assert tests.affected($q$update public.shipments set status = 'planning'
    where id = '9b000000-0000-4000-8000-000000000022'$q$) = 1, 'S7a: closed shipment reopened';
  assert tests.affected($q$update public.shipments set status = 'cancelled'
    where id = '9b000000-0000-4000-8000-000000000021'$q$) = 1, 'S7b: shipment cancelled without a reason';
  assert tests.affected($q$insert into public.shipments (shipment_number, type, supplier_id, route_id, process_template_id,
      currency_id, destination_warehouse_id, responsible_user_id, created_by, status, is_locked)
    select 'FAKE-0001', 'import', supplier_id, route_id, process_template_id, currency_id, destination_warehouse_id,
      responsible_user_id, '9a000000-0000-4000-8000-000000000003', 'closed', true
    from public.shipments where id = '9b000000-0000-4000-8000-000000000022'$q$) = 1,
    'S7c: a closed shipment without stages inserted directly';
end;
$$;

reset role;

-- S6c. The notification helper still writes for employees without the object permission --------
do $$
begin
  assert private.notify('9a000000-0000-4000-8000-000000000006', 'stage_blocked', 'Этап заблокирован', null,
    'shipment_stage_run', '9b000000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000021'),
    'S6c: shipment notification created for an employee denied shipments.view';
  assert private.notify('9a000000-0000-4000-8000-000000000003', 'approval_decision', 'Документ согласован', null,
    'document', '9b000000-0000-4000-8000-000000000099', null),
    'S6c: document notification created for an employee denied documents.view';
end;
$$;

\echo 'security audit: every bypass reproduced on the schema before 202609272300'
rollback;
