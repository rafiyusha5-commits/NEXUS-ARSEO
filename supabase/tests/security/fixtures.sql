-- Shared fixtures of the database security audit (docs/security-audit.md). Included by
-- supabase/tests/before/202609272300_database_security_hardening.sql (runs on the schema
-- before the fix, inside a rolled-back transaction) and supabase/tests/security_audit.test.sql
-- (runs after all migrations). Everything is inserted as postgres; ids use the 9a/9b
-- prefixes, which no other test file uses.

create schema if not exists tests;
grant usage on schema tests to authenticated, anon;

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

create or replace function tests.affected(p_sql text) returns integer
language plpgsql as $$
declare
  v_count integer;
begin
  execute p_sql;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function tests.act_as(p_user uuid) returns void
language sql as $$ select set_config('request.jwt.claim.sub', p_user::text, false) $$;

grant execute on all functions in schema tests to authenticated;

-- Users:
--   01 administrator; 02 director (personal deny of audit.view);
--   03 specialist "Spec" (personal deny of documents.view) — the main attacker;
--   04 specialist "Spec2" (personal deny of shipments.approve) — a named approver;
--   05 self-registered account without any role;
--   06 specialist "Viewer" (personal deny of shipments.view);
--   07 specialist "Importer" (personal deny of products.view);
--   09 specialist "Blind": the role grants shipments.update and shipments.change_status (and
--      inventory.receive), only shipments.view is denied personally.
insert into auth.users (id, email, raw_user_meta_data) values
  ('9a000000-0000-4000-8000-000000000001', 'sec-admin@test.local', '{"full_name":"Администратор"}'),
  ('9a000000-0000-4000-8000-000000000002', 'sec-director@test.local', '{"full_name":"Директор"}'),
  ('9a000000-0000-4000-8000-000000000003', 'sec-spec@test.local', '{"full_name":"Специалист"}'),
  ('9a000000-0000-4000-8000-000000000004', 'sec-spec2@test.local', '{"full_name":"Специалист 2"}'),
  ('9a000000-0000-4000-8000-000000000005', 'sec-signup@test.local', '{"full_name":"Самозапись"}'),
  ('9a000000-0000-4000-8000-000000000006', 'sec-viewer@test.local', '{"full_name":"Без поставок"}'),
  ('9a000000-0000-4000-8000-000000000007', 'sec-importer@test.local', '{"full_name":"Импортёр"}'),
  ('9a000000-0000-4000-8000-000000000009', 'sec-blind@test.local', '{"full_name":"Без просмотра поставок"}');

insert into public.user_roles (user_id, role_id)
select u.id::uuid, r.id
from (values
  ('9a000000-0000-4000-8000-000000000001', 'administrator'),
  ('9a000000-0000-4000-8000-000000000002', 'director'),
  ('9a000000-0000-4000-8000-000000000003', 'logistics_specialist'),
  ('9a000000-0000-4000-8000-000000000004', 'logistics_specialist'),
  ('9a000000-0000-4000-8000-000000000006', 'logistics_specialist'),
  ('9a000000-0000-4000-8000-000000000007', 'logistics_specialist'),
  ('9a000000-0000-4000-8000-000000000009', 'logistics_specialist')
) as u(id, role_code)
join public.app_roles r on r.code = u.role_code;

insert into public.user_permission_overrides (user_id, permission_id, effect, reason, granted_by)
select u.id::uuid, p.id, 'deny', 'security audit fixture', '9a000000-0000-4000-8000-000000000001'
from (values
  ('9a000000-0000-4000-8000-000000000002', 'audit.view'),
  ('9a000000-0000-4000-8000-000000000003', 'documents.view'),
  ('9a000000-0000-4000-8000-000000000004', 'shipments.approve'),
  ('9a000000-0000-4000-8000-000000000006', 'shipments.view'),
  ('9a000000-0000-4000-8000-000000000007', 'products.view'),
  ('9a000000-0000-4000-8000-000000000009', 'shipments.view')
) as u(id, code)
join public.permissions p on p.code = u.code;

insert into public.counterparties (id, roles, legal_name, country) values
  ('9b000000-0000-4000-8000-000000000001', array['supplier', 'manufacturer'], 'SEC Supplier Oy', 'FI');

-- A product with a confidential purchase price.
insert into public.products (id, internal_sku, name, manufacturer_id, status, brand, base_purchase_price) values
  ('9b000000-0000-4000-8000-000000000011', 'SEC-001', '{"ru":"Товар аудита"}', '9b000000-0000-4000-8000-000000000001', 'active', 'Старый бренд', 123.45);

-- An open shipment (Spec is responsible) and a closed one.
insert into public.shipments (id, shipment_number, type, supplier_id, route_id, process_template_id, currency_id,
  destination_warehouse_id, responsible_user_id, created_by, status)
select v.id::uuid, v.number, 'import', '9b000000-0000-4000-8000-000000000001',
  (select id from public.routes where origin_country = 'FI' and destination_country = 'KZ' limit 1),
  (select id from public.process_templates where code = 'import_eu_kz' and version = 1),
  (select id from public.currencies where code = 'EUR'),
  (select id from public.warehouses where code = 'AKT'),
  '9a000000-0000-4000-8000-000000000003', '9a000000-0000-4000-8000-000000000002', v.status
from (values
  ('9b000000-0000-4000-8000-000000000021', 'SEC-2026-0001', 'planning'),
  ('9b000000-0000-4000-8000-000000000022', 'SEC-2026-0002', 'closed')
) as v(id, number, status);

insert into public.shipment_stage_runs (id, shipment_id, stage_id, status, responsible_user_id)
select '9b000000-0000-4000-8000-000000000031', '9b000000-0000-4000-8000-000000000021', s.id, 'pending',
  '9a000000-0000-4000-8000-000000000003'
from public.shipment_stages s
where s.code = 'documents_check'
  and s.process_template_id = (select id from public.process_templates where code = 'import_eu_kz' and version = 1);

insert into public.shipment_transports (id, shipment_id, sequence_no, status) values
  ('9b000000-0000-4000-8000-000000000041', '9b000000-0000-4000-8000-000000000021', 1, 'planned');

insert into public.shipment_items (id, shipment_id, product_id, ordered_quantity, uom, unit_price, currency_id)
select '9b000000-0000-4000-8000-000000000051', '9b000000-0000-4000-8000-000000000021',
  '9b000000-0000-4000-8000-000000000011', 100, 'piece', 9.99, (select id from public.currencies where code = 'EUR');

insert into public.customs_clearances (id, shipment_id, country) values
  ('9b000000-0000-4000-8000-000000000052', '9b000000-0000-4000-8000-000000000021', 'KZ');

-- A finished task of Spec, created by the director.
insert into public.tasks (id, title, assignee_user_id, created_by, status, completed_at) values
  ('9b000000-0000-4000-8000-000000000061', 'Закрытая задача аудита', '9a000000-0000-4000-8000-000000000003',
   '9a000000-0000-4000-8000-000000000002', 'done', now());

-- Approvals: a document request by Spec, a shipment request with Spec2 as named approver, a
-- shipment request by Viewer (who is denied shipments.view).
insert into public.approvals (id, entity_type, entity_id, approver_role, approver_user_id, requested_by, status, request_comment) values
  ('9b000000-0000-4000-8000-000000000071', 'document', '9b000000-0000-4000-8000-000000000099', 'documents.approve', null,
   '9a000000-0000-4000-8000-000000000003', 'pending', 'Конфиденциальный запрос'),
  ('9b000000-0000-4000-8000-000000000072', 'shipment', '9b000000-0000-4000-8000-000000000021', null,
   '9a000000-0000-4000-8000-000000000004', '9a000000-0000-4000-8000-000000000003', 'pending', null),
  ('9b000000-0000-4000-8000-000000000074', 'shipment', '9b000000-0000-4000-8000-000000000021', null,
   '9a000000-0000-4000-8000-000000000002', '9a000000-0000-4000-8000-000000000006', 'pending', null);

-- Notifications created before the personal denies: a document decision for Spec and a
-- blocked stage for Viewer.
insert into public.notifications (id, recipient_user_id, type, title, entity_type, entity_id, shipment_id) values
  ('9b000000-0000-4000-8000-000000000081', '9a000000-0000-4000-8000-000000000003', 'approval_decision',
   'Согласование завершено: документ «Секретный договор»', 'document', '9b000000-0000-4000-8000-000000000099', null),
  ('9b000000-0000-4000-8000-000000000082', '9a000000-0000-4000-8000-000000000006', 'stage_blocked',
   'Этап заблокирован: поставка SEC-2026-0001', 'shipment_stage_run', '9b000000-0000-4000-8000-000000000031',
   '9b000000-0000-4000-8000-000000000021');

-- The reference-import package the importer runs (updates the brand of SEC-001).
create table if not exists tests.sec_package (payload jsonb not null);
insert into tests.sec_package values
  ('{"format":"nexus-reference-import","version":1,"products":[{"internal_sku":"SEC-001","brand":"Новый бренд"}]}');
grant select on tests.sec_package to authenticated;
