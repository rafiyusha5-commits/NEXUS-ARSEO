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
end;
$$;

-- S1. EXECUTE follows an explicit allowlist. This copy is independent of the migration: every
-- function of the project (extensions excluded) is compared, with the effective privilege
-- (PUBLIC included) of authenticated, service_role and anon.
create table tests.sec_exec_allow (role_name text, fn text, primary key (role_name, fn));
insert into tests.sec_exec_allow
select 'authenticated', unnest(array[
  'public.historical_sale_receipt_preview', 'public.record_historical_sale_receipt',
  'public.can_record_historical_sale', 'public.create_historical_customer_order',
  'public.list_operational_archives', 'public.read_operational_archive',
  'public.prepare_assistant_operation', 'public.review_assistant_operation', 'public.confirm_assistant_operation',
  'public.preview_customer_order_reservation_replacement', 'public.replace_customer_order_reservations',
  'public.return_customer_order_to_preparation',
  'public.add_shipment_transport', 'public.import_calculator_master_data', 'public.my_product_master_confidential_data', 'public.my_product_master_sources', 'public.create_shipment_transport', 'public.update_shipment_transport', 'public.remove_shipment_transport', 'public.assign_source_extraction_transport', 'public.allocate_shipment_item', 'public.approve_document_template',
  'public.add_sticker_template_version', 'public.change_sticker_order_status', 'public.create_marking_code_order', 'public.create_sticker_order', 'public.create_sticker_template',
  'public.add_customer_order_item', 'public.archive_document', 'public.archive_document_template', 'public.cancel_customer_order', 'public.cancel_listing_card',
  'public.change_shipment_operational_state', 'public.change_shipment_stage_status', 'public.correct_shipment_dates',
  'public.change_sale_guarantee_status', 'public.change_shipment_transport_status', 'public.change_task_due', 'public.create_customer_order',
  'public.create_listing_card_version', 'public.create_sale_guarantee_letter', 'public.create_shipment_with_stages', 'public.create_task', 'public.decide_document_review',
  'public.delete_shipment_item', 'public.import_reference_data', 'public.issue_inventory_fifo',
  'public.confirm_customer_order', 'public.fulfill_customer_order', 'public.mark_all_notifications_read', 'public.mark_notification_read', 'public.my_document_permissions',
  'public.search_drive_catalog', 'public.my_permissions', 'public.operational_summary', 'public.reassign_task', 'public.receive_inventory_batch', 'public.receive_shipment_transport',
  'public.run_logist', 'public.accept_logist_proposal', 'public.reject_logist_proposal',
  'public.record_listing_card_decision', 'public.refresh_my_deadline_notifications', 'public.register_document',
  'private.shipment_drive_allowed', 'public.bind_shipment_drive_folder', 'public.scan_shipment_drive_folder', 'public.import_shipment_drive_file',
  'public.check_shipment_drive_content', 'public.link_shipment_drive_document', 'public.save_historical_shipment_draft',
  'public.begin_shipment_drive_operation', 'public.record_shipment_drive_operation',
  'public.register_document_template', 'public.set_document_template_active', 'public.set_inventory_batch_status',
  'public.reserve_customer_order_item_fefo', 'public.reserve_customer_order_item_override', 'public.set_task_status', 'public.submit_document_for_review', 'public.submit_listing_card',
  'public.update_shipment_item', 'public.apply_shipment_document_quantities', 'public.shipment_quantity_provenance',
  'public.decide_sticker_template_version', 'public.record_sticker_application', 'public.submit_sticker_template_version', 'public.update_marking_code_order',
  'public.add_exchange_rate', 'public.create_expense', 'public.confirm_expense', 'public.allocate_expense', 'public.mark_expense_paid', 'public.calculate_shipment_cost', 'public.approve_shipment_cost',
  'public.customer_return_options', 'public.assistant_customer_return_options', 'public.assistant_return_decision_options', 'public.assistant_return_cancellation_options', 'public.create_customer_return', 'public.decide_customer_return_item', 'public.cancel_customer_return',
  'public.configure_integration', 'public.resolve_synchronization_error',
  'public.create_forecast', 'public.create_forecast_version', 'public.upsert_forecast_line', 'public.remove_forecast_line',
  'public.submit_forecast', 'public.review_forecast', 'public.approve_forecast', 'public.archive_forecast',
  'public.customer_receivables', 'public.customer_statement', 'public.customer_credit_check', 'public.record_sale_credit_decision', 'public.set_customer_credit_terms',
  'public.preview_receivables_import', 'public.confirm_receivables_import', 'public.resolve_bank_line', 'public.add_customer_balance_adjustment', 'public.record_reconciliation_act',
  'public.create_purchase_plan', 'public.create_purchase_plan_version', 'public.upsert_purchase_plan_line', 'public.remove_purchase_plan_line',
  'public.submit_purchase_plan', 'public.review_purchase_plan', 'public.approve_purchase_plan', 'public.create_purchase_plan_shipment', 'public.archive_purchase_plan',
  'public.create_commercial_program', 'public.create_commercial_program_version', 'public.upsert_commercial_program_line', 'public.remove_commercial_program_line',
  'public.submit_commercial_program', 'public.review_commercial_program', 'public.approve_commercial_program', 'public.apply_commercial_program_to_forecast',
  'public.create_sale_from_commercial_program', 'public.archive_commercial_program', 'public.customer_order_shipping_blockers',
  'public.refresh_my_order_notifications', 'public.reschedule_customer_order',
  'public.my_external_document_permissions', 'public.my_external_documents', 'public.my_external_document', 'public.my_external_document_file', 'public.update_my_external_profile', 'public.register_external_document', 'public.record_external_document_access',
  'public.set_document_external_access', 'public.configure_external_client', 'public.set_external_client_access',
  'public.create_shipment_milestone', 'public.complete_shipment_milestone', 'public.cancel_shipment_milestone', 'public.my_shipment_calendar',
  'public.register_generated_document', 'public.register_generated_document_package',
  'public.upsert_shipment_source_extraction', 'public.confirm_shipment_source_extraction', 'public.review_shipment_source_extraction', 'public.review_shipment_customs_evidence', 'public.save_shipment_customs_match', 'public.review_mapped_shipment_customs', 'public.revise_shipment_customs_evidence',
  'public.begin_shipment_source_ocr', 'public.finish_shipment_source_ocr_fenced',
  'public.create_inventory_operation_document', 'public.add_inventory_operation_line', 'public.remove_inventory_operation_line',
  'public.post_inventory_operation_document', 'public.cancel_inventory_operation_document',
  'public.my_agent_usage', 'public.create_my_telegram_code', 'public.confirm_my_telegram_link', 'public.unlink_my_telegram',
  'public.sync_calculator_purchase_prices', 'public.create_shipment_item', 'public.my_product_purchase_prices',
  'public.my_shipment_item_purchase_prices', 'public.my_inventory_batch_costs',
  'public.cancel_expense', 'public.reverse_expense',
  'public.shipment_document_check', 'public.run_shipment_document_check', 'public.reopen_shipment',
  'public.shelf_life_risks',
  'private.drive_gateway_allowed', 'private.barcode_key', 'private.can_access_counterparty', 'private.can_access_counterparty_record',
  'private.can_write_shipments', 'private.document_is_active', 'private.has_active_deny',
  'private.has_permission', 'private.is_employee', 'private.is_own_new_document', 'private.is_own_new_template',
  'private.is_registered_document_file', 'private.is_registered_template_file', 'private.can_view_generated_document', 'private.can_read_registered_document_file', 'private.listing_card_is_draft',
  'private.template_is_active', 'private.is_external_client', 'private.external_has_permission',
  'private.external_can_access_document', 'private.external_can_read_document_file', 'private.external_can_upload_document_file',
  'private.document_matches_counterparty', 'private.document_is_external_safe'])
union all
select 'service_role', unnest(array['public.generate_deadline_notifications', 'public.start_synchronization_run', 'public.finish_synchronization_run', 'private.barcode_key',
  'public.drive_catalog_sync_step', 'public.agent_reserve_run', 'public.agent_finish_run', 'public.telegram_request_link', 'public.telegram_employee',
  'public.telegram_authorize_delivery', 'public.telegram_unlink_chat', 'public.telegram_claim_update', 'public.telegram_update_status', 'public.telegram_update_progress',
  'public.run_document_checks', 'public.run_shelf_life_control']);

do $$
declare
  v_role text;
  v_extra text;
  v_missing text;
begin
  foreach v_role in array array['authenticated', 'service_role', 'anon'] loop
    with fns as (
      select p.oid, n.nspname || '.' || p.proname as fn
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private')
        and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'))
    select string_agg(fn, ', ' order by fn) filter (where has_function_privilege(v_role, oid, 'execute')
             and fn not in (select a.fn from tests.sec_exec_allow a where a.role_name = v_role)),
           string_agg(fn, ', ' order by fn) filter (where not has_function_privilege(v_role, oid, 'execute')
             and fn in (select a.fn from tests.sec_exec_allow a where a.role_name = v_role))
    into v_extra, v_missing
    from fns;
    assert v_extra is null, format('S1: %s may execute functions outside the allowlist: %s', v_role, v_extra);
    assert v_missing is null, format('S1: %s lacks allowlisted functions: %s', v_role, v_missing);
  end loop;
  -- Spelled out as well: no trigger function and no internal helper for anybody.
  assert not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private') and p.prorettype = 'trigger'::regtype
      and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))
  ), 'S1: trigger functions are not executable';
  assert not has_function_privilege('authenticated', 'private.notify(uuid, text, text, text, text, uuid, uuid, text)', 'execute')
     and not has_function_privilege('authenticated', 'private.has_role(text)', 'execute')
     and not has_function_privilege('authenticated', 'public.generate_deadline_notifications(timestamptz)', 'execute')
     and not has_function_privilege('authenticated', 'private.run_reference_import(jsonb)', 'execute'),
    'S1: internal and service-only functions are not executable by employees';
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
-- Two more pending requests: 75 names the director, 76 names only a role.
insert into public.approvals (id, entity_type, entity_id, approver_user_id, requested_by)
values ('9b000000-0000-4000-8000-000000000075', 'shipment', '9b000000-0000-4000-8000-000000000021',
        '9a000000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000003');
insert into public.approvals (id, entity_type, entity_id, approver_role, requested_by)
values ('9b000000-0000-4000-8000-000000000076', 'shipment', '9b000000-0000-4000-8000-000000000021',
        'senior_logistics_manager', '9a000000-0000-4000-8000-000000000003');

select tests.act_as('9a000000-0000-4000-8000-000000000002'); -- the director
-- S5f. Without a decision neither the comment nor the time changes; the client never sends the time.
select tests.expect_error($$
  update public.approvals set comment = 'Без решения' where id = '9b000000-0000-4000-8000-000000000075'
$$, 'только вместе с решением');
select tests.expect_error($$
  update public.approvals set decided_at = now() where id = '9b000000-0000-4000-8000-000000000075'
$$, 'permission denied');
select tests.expect_error($$
  update public.approvals set status = 'approved', decided_at = timestamptz '2000-01-01'
  where id = '9b000000-0000-4000-8000-000000000073'
$$, 'permission denied');
update public.approvals set status = 'approved', comment = 'Согласовано' where id = '9b000000-0000-4000-8000-000000000073';
update public.approvals set status = 'rejected', comment = 'Нет документов' where id = '9b000000-0000-4000-8000-000000000076';
-- S5f. A decided request does not change: status, comment and time are fixed.
select tests.expect_error($$
  update public.approvals set status = 'rejected' where id = '9b000000-0000-4000-8000-000000000073'
$$, 'уже обработан');
select tests.expect_error($$
  update public.approvals set comment = 'Переписано задним числом' where id = '9b000000-0000-4000-8000-000000000073'
$$, 'уже обработан');
select tests.expect_error($$
  update public.approvals set decided_at = timestamptz '2000-01-01' where id = '9b000000-0000-4000-8000-000000000073'
$$, 'permission denied');
reset role;
-- The trigger enforces the same for code that bypasses column privileges (postgres here).
select tests.expect_error($$
  update public.approvals set decided_at = timestamptz '2000-01-01' where id = '9b000000-0000-4000-8000-000000000073'
$$, 'уже обработан');
select tests.expect_error($$
  update public.approvals set comment = 'Переписано' where id = '9b000000-0000-4000-8000-000000000073'
$$, 'уже обработан');
select tests.expect_error($$
  update public.approvals set decided_at = now() where id = '9b000000-0000-4000-8000-000000000075'
$$, 'только вместе с решением');
select tests.expect_error($$
  update public.approvals set requested_by = '9a000000-0000-4000-8000-000000000002' where id = '9b000000-0000-4000-8000-000000000075'
$$, 'не меняются');
do $$
begin
  assert (select decided_at > now() - interval '1 minute' and comment = 'Согласовано'
          and approver_user_id = '9a000000-0000-4000-8000-000000000002'
          from public.approvals where id = '9b000000-0000-4000-8000-000000000073'),
    'S5a: time set by the database, comment kept';
  assert (select approver_user_id = '9a000000-0000-4000-8000-000000000002' and status = 'rejected'
          and decided_at > now() - interval '1 minute'
          from public.approvals where id = '9b000000-0000-4000-8000-000000000076'),
    'S5f: the actual approver is recorded by the trigger';
  assert (select status = 'pending' and comment is null and decided_at is null
          from public.approvals where id = '9b000000-0000-4000-8000-000000000075'),
    'S5f: the pending request is untouched';
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
select tests.expect_error($$select public.update_shipment_item('9b000000-0000-4000-8000-000000000051',90,9.99)$$,'Нет права изменять закупочную цену');
-- A logistics specialist may still change quantity; NULL preserves the hidden price.
select public.update_shipment_item('9b000000-0000-4000-8000-000000000051', 90, null);
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

-- S12. A personal deny of shipments.view blocks every shipment operation, even with the UUID ---------
-- Blind: the role grants shipments.update, shipments.change_status and inventory.receive; only
-- shipments.view is denied. Every read returns nothing and every write is refused, directly
-- and through each RPC; an unknown UUID gets the same answer as a real one.
reset role;
create temp table sec_blind_before as
  select 'shipment' as kind, to_jsonb(s) as row from public.shipments s where s.id = '9b000000-0000-4000-8000-000000000021'
  union all select 'item', to_jsonb(i) from public.shipment_items i where i.shipment_id = '9b000000-0000-4000-8000-000000000021'
  union all select 'run', to_jsonb(r) from public.shipment_stage_runs r where r.shipment_id = '9b000000-0000-4000-8000-000000000021'
  union all select 'transport', to_jsonb(t) from public.shipment_transports t where t.shipment_id = '9b000000-0000-4000-8000-000000000021'
  union all select 'customs', to_jsonb(c) from public.customs_clearances c where c.shipment_id = '9b000000-0000-4000-8000-000000000021';
create temp table sec_blind_history as
  select count(*) as n from public.shipment_stage_history where shipment_id = '9b000000-0000-4000-8000-000000000021';
set role authenticated;
select tests.act_as('9a000000-0000-4000-8000-000000000009');
do $$
begin
  assert (select private.has_permission('shipments.update')) and (select private.has_permission('shipments.change_status'))
     and (select private.has_permission('inventory.receive')), 'S12: the role grants the shipment actions';
  assert not (select private.has_permission('shipments.view')), 'S12: only viewing is denied';
  assert not exists (select 1 from public.shipments where id = '9b000000-0000-4000-8000-000000000021'), 'S12: shipment unreadable';
  assert not exists (select 1 from public.shipment_items where id = '9b000000-0000-4000-8000-000000000051'), 'S12: items unreadable';
  assert not exists (select 1 from public.shipment_stage_runs where id = '9b000000-0000-4000-8000-000000000031'), 'S12: stages unreadable';
  assert not exists (select 1 from public.shipment_stage_history where shipment_id = '9b000000-0000-4000-8000-000000000021'), 'S12: history unreadable';
  assert not exists (select 1 from public.shipment_transports where id = '9b000000-0000-4000-8000-000000000041'), 'S12: transports unreadable';
  assert not exists (select 1 from public.customs_clearances where id = '9b000000-0000-4000-8000-000000000052'), 'S12: customs unreadable';
  assert tests.affected($q$update public.shipments set planned_arrival_date = current_date + 1 where id = '9b000000-0000-4000-8000-000000000021'$q$) = 0,
    'S12: direct update of an editable field changes nothing';
  assert tests.affected($q$update public.customs_clearances set declaration_number = 'BLIND'
    where id = '9b000000-0000-4000-8000-000000000052'$q$) = 0, 'S12: customs update changes nothing';
end;
$$;
select tests.expect_error($$ update public.shipments set status = 'on_hold' where id = '9b000000-0000-4000-8000-000000000021' $$, 'permission denied');
select tests.expect_error($$
  insert into public.shipment_items (shipment_id, product_id, ordered_quantity)
  values ('9b000000-0000-4000-8000-000000000021', '9b000000-0000-4000-8000-000000000011', 1)
$$, 'permission denied');
select tests.expect_error($$
  insert into public.customs_clearances (shipment_id, country) values ('9b000000-0000-4000-8000-000000000021', 'KZ')
$$, 'row-level security');
select tests.expect_error($$
  select public.create_shipment_with_stages('BLIND', 'import', '9b000000-0000-4000-8000-000000000001', null,
    (select id from public.routes where origin_country = 'FI' and destination_country = 'KZ' limit 1),
    (select id from public.currencies where code = 'EUR'), (select id from public.warehouses where code = 'AKT'),
    '9a000000-0000-4000-8000-000000000009', null, null)
$$, 'Недостаточно прав');
select tests.expect_error($$ select public.change_shipment_stage_status('9b000000-0000-4000-8000-000000000031', 'completed') $$, 'Недостаточно прав');
select tests.expect_error($$ select public.add_shipment_transport('9b000000-0000-4000-8000-000000000021') $$, 'Недостаточно прав');
select tests.expect_error($$ select public.change_shipment_operational_state('9b000000-0000-4000-8000-000000000021', 'hold', 'Blind') $$, 'Недостаточно прав');
select tests.expect_error($$
  select public.allocate_shipment_item('9b000000-0000-4000-8000-000000000051', '9b000000-0000-4000-8000-000000000041', 1)
$$, 'Недостаточно прав');
select tests.expect_error($$ select public.update_shipment_item('9b000000-0000-4000-8000-000000000051', 80, 0.01) $$, 'Недостаточно прав');
select tests.expect_error($$ select public.delete_shipment_item('9b000000-0000-4000-8000-000000000051') $$, 'Недостаточно прав');
select tests.expect_error($$ select public.change_shipment_transport_status('9b000000-0000-4000-8000-000000000041', 'loading') $$, 'Недостаточно прав');
select tests.expect_error($$
  select public.receive_inventory_batch('9b000000-0000-4000-8000-000000000051', (select id from public.warehouses where code = 'AKT'),
    null, 'BLIND-1', null, current_date + 100, 1, null)
$$, 'Недостаточно прав');
select tests.expect_error($$ select public.update_shipment_item(gen_random_uuid(), 80, 0.01) $$, 'Недостаточно прав');
select tests.expect_error($$ select public.change_shipment_operational_state(gen_random_uuid(), 'hold', 'Blind') $$, 'Недостаточно прав');
reset role;
do $$
begin
  -- every row of the shipment, its items, stages, transports and customs is byte-for-byte the same
  assert not exists (
    (select kind, row from sec_blind_before)
    except
    (select 'shipment', to_jsonb(s) from public.shipments s where s.id = '9b000000-0000-4000-8000-000000000021'
     union all select 'item', to_jsonb(i) from public.shipment_items i where i.shipment_id = '9b000000-0000-4000-8000-000000000021'
     union all select 'run', to_jsonb(r) from public.shipment_stage_runs r where r.shipment_id = '9b000000-0000-4000-8000-000000000021'
     union all select 'transport', to_jsonb(t) from public.shipment_transports t where t.shipment_id = '9b000000-0000-4000-8000-000000000021'
     union all select 'customs', to_jsonb(c) from public.customs_clearances c where c.shipment_id = '9b000000-0000-4000-8000-000000000021')
  ), 'S12: the shipment and its items, stages, transports and customs are unchanged';
  assert (select count(*) from sec_blind_before) =
         (select 1 + (select count(*) from public.shipment_items where shipment_id = '9b000000-0000-4000-8000-000000000021')
                   + (select count(*) from public.shipment_stage_runs where shipment_id = '9b000000-0000-4000-8000-000000000021')
                   + (select count(*) from public.shipment_transports where shipment_id = '9b000000-0000-4000-8000-000000000021')
                   + (select count(*) from public.customs_clearances where shipment_id = '9b000000-0000-4000-8000-000000000021')),
    'S12: no rows were added to the shipment';
  assert (select count(*) from public.shipment_stage_history where shipment_id = '9b000000-0000-4000-8000-000000000021')
       = (select n from sec_blind_history), 'S12: no stage history was written';
  assert (select ordered_quantity = 90 and unit_price = 9.99 from public.shipment_items where id = '9b000000-0000-4000-8000-000000000051'),
    'S12: the item is unchanged';
  assert (select status <> 'on_hold' and hold_reason is null from public.shipments where id = '9b000000-0000-4000-8000-000000000021'), 'S12: the shipment is not on hold';
  assert (select status = 'planned' from public.shipment_transports where id = '9b000000-0000-4000-8000-000000000041'), 'S12: the transport is unchanged';
  assert (select status = 'in_progress' from public.shipment_stage_runs where id = '9b000000-0000-4000-8000-000000000031'), 'S12: the stage is unchanged';
  assert not exists (select 1 from public.shipments where project_code = 'BLIND'), 'S12: no shipment was created';
  assert not exists (select 1 from public.inventory_batches where batch_number = 'BLIND-1'), 'S12: nothing was received';
  assert (select count(*) from public.shipment_transports where shipment_id = '9b000000-0000-4000-8000-000000000021') = 2, 'S12: no transport was added';
end;
$$;
drop table sec_blind_before, sec_blind_history;
set role authenticated;
select tests.act_as('9a000000-0000-4000-8000-000000000003');

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
