-- S11 of the database security audit (docs/security-audit.md): a personal deny beats the role
-- in every module. Runs last (zz_) so that every module table already holds rows from the
-- other test files; the few tables no other test fills get a row here.
--
-- A director — the widest business role — with a personal deny of every permission must read
-- nothing from any module table: no role grant, no "manage" permission and no ownership branch
-- may open a row. The administrator reads the same tables, and every one of them must hold
-- data, so the check is never vacuous. Employee-wide reference tables (currencies, document
-- types, process settings, profiles, roles and permissions) are outside the list by design.

\set ON_ERROR_STOP 1

create schema if not exists tests;
grant usage on schema tests to authenticated;
create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;
grant execute on function tests.act_as(uuid) to authenticated;

insert into auth.users (id, email, raw_user_meta_data) values
  ('9c000000-0000-4000-8000-000000000001', 'matrix-admin@test.local', '{"full_name":"Администратор матрицы"}'),
  ('9c000000-0000-4000-8000-000000000002', 'matrix-director@test.local', '{"full_name":"Директор под запретом"}');
insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values ('9c000000-0000-4000-8000-000000000001', 'administrator'),
             ('9c000000-0000-4000-8000-000000000002', 'director')) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;
insert into public.user_permission_overrides (user_id, permission_id, effect, reason, granted_by)
select '9c000000-0000-4000-8000-000000000002', p.id, 'deny', 'deny everything', '9c000000-0000-4000-8000-000000000001'
from public.permissions p;

-- Rows for the tables no other test file fills (as postgres).
insert into public.counterparties (id, roles, legal_name, country) values
  ('9c000000-0000-4000-8000-000000000011', array['supplier', 'manufacturer', 'carrier', 'broker'], 'Matrix Partner Oy', 'FI');
insert into public.counterparties_contacts (counterparty_id, full_name, phone) values
  ('9c000000-0000-4000-8000-000000000011', 'Контакт матрицы', '+358000000000');
insert into public.contracts (id, counterparty_id, number, type) values
  ('9c000000-0000-4000-8000-000000000012', '9c000000-0000-4000-8000-000000000011', 'MATRIX-1', 'supply');
insert into public.contract_terms (contract_id, term_type, value_numeric) values
  ('9c000000-0000-4000-8000-000000000012', 'price', 1);
insert into public.warehouse_locations (warehouse_id, code, zone)
select id, 'MATRIX-L1', 'storage' from public.warehouses where code = 'AKT';
insert into public.carriers (id, counterparty_id) values
  ('9c000000-0000-4000-8000-000000000013', '9c000000-0000-4000-8000-000000000011');
insert into public.vehicles (carrier_id, plate_number, vehicle_type) values
  ('9c000000-0000-4000-8000-000000000013', 'MATRIX 001', 'truck');
insert into public.brokers (counterparty_id) values ('9c000000-0000-4000-8000-000000000011');
insert into public.products (id, internal_sku, name, manufacturer_id, status) values
  ('9c000000-0000-4000-8000-000000000014', 'MATRIX-001', '{"ru":"Товар матрицы"}', '9c000000-0000-4000-8000-000000000011', 'active');
insert into public.shipments (id, shipment_number, type, supplier_id, route_id, process_template_id, currency_id,
  destination_warehouse_id, responsible_user_id, created_by)
select '9c000000-0000-4000-8000-000000000015', 'MATRIX-2026-0001', 'import', '9c000000-0000-4000-8000-000000000011',
  (select id from public.routes where origin_country = 'FI' and destination_country = 'KZ' limit 1),
  (select id from public.process_templates where code = 'import_eu_kz' and version = 1),
  (select id from public.currencies where code = 'EUR'),
  (select id from public.warehouses where code = 'AKT'),
  '9c000000-0000-4000-8000-000000000001', '9c000000-0000-4000-8000-000000000001';
insert into public.customs_clearances (shipment_id, country) values ('9c000000-0000-4000-8000-000000000015', 'KZ');
insert into public.inventory_batches (id, product_id, batch_number, expiry_date, created_by) values
  ('9c000000-0000-4000-8000-000000000016', '9c000000-0000-4000-8000-000000000014', 'MATRIX-B1', current_date + 100,
   '9c000000-0000-4000-8000-000000000001');
insert into public.inventory_balances (batch_id, warehouse_id, uom, quantity_on_hand)
select '9c000000-0000-4000-8000-000000000016', id, 'piece', 5 from public.warehouses where code = 'AKT';
insert into public.inventory_movements (batch_id, movement_type, quantity, uom, to_warehouse_id, created_by)
select '9c000000-0000-4000-8000-000000000016', 'receipt', 5, 'piece', id, '9c000000-0000-4000-8000-000000000001'
from public.warehouses where code = 'AKT';

create table tests.matrix_tables (name text primary key, admin_rows bigint);
insert into tests.matrix_tables (name) values
  ('counterparties'), ('counterparties_contacts'), ('contracts'), ('contract_terms'),
  ('products'), ('product_identifiers'), ('product_packaging'),
  ('warehouses'), ('warehouse_locations'), ('routes'), ('carriers'), ('vehicles'), ('brokers'),
  ('shipments'), ('shipment_items'), ('shipment_transports'), ('shipment_stage_runs'), ('shipment_stage_history'),
  ('customs_clearances'),
  ('inventory_batches'), ('inventory_balances'), ('inventory_movements'), ('inventory_fifo_status'),
  ('documents'), ('document_versions'), ('document_links'), ('document_requirements'),
  ('document_templates'), ('document_template_versions'),
  ('product_listing_cards'), ('product_listing_card_items'),
  ('tasks'), ('audit_log'), ('approvals'), ('notifications');
grant select, update on tests.matrix_tables to authenticated;

set role authenticated;
select tests.act_as('9c000000-0000-4000-8000-000000000001'); -- administrator: the reference
do $$
declare
  v_table text;
  v_count bigint;
begin
  for v_table in select name from tests.matrix_tables loop
    execute format('select count(*) from public.%I', v_table) into v_count;
    update tests.matrix_tables set admin_rows = v_count where name = v_table;
  end loop;
end;
$$;
reset role;

-- The administrator is not a recipient of other people's notifications and approvals; those two
-- are checked against the table as a whole.
do $$
begin
  update tests.matrix_tables set admin_rows = (select count(*) from public.notifications) where name = 'notifications';
  update tests.matrix_tables set admin_rows = (select count(*) from public.approvals) where name = 'approvals';
  assert not exists (select 1 from tests.matrix_tables where admin_rows = 0),
    format('the deny matrix would be vacuous for: %s',
           (select string_agg(name, ', ') from tests.matrix_tables where admin_rows = 0));
end;
$$;

set role authenticated;
select tests.act_as('9c000000-0000-4000-8000-000000000002'); -- director with every permission denied
do $$
declare
  v_table text;
  v_count bigint;
begin
  assert (select private.is_employee()), 'still an active employee with a role';
  for v_table in select name from tests.matrix_tables loop
    execute format('select count(*) from public.%I', v_table) into v_count;
    assert v_count = 0, format('S11: %s shows %s rows despite the personal deny', v_table, v_count);
  end loop;
end;
$$;
reset role;

\echo 'zz_personal_deny_matrix: all checks passed'
