-- Synthetic fixtures only. Caller chooses transaction / rollback boundary.
create schema if not exists tests;
grant usage on schema tests to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('fc000000-0000-4000-8000-000000000001','freight-admin@example.invalid','{"full_name":"Freight test admin"}'),
 ('fc000000-0000-4000-8000-000000000002','freight-logistics@example.invalid','{"full_name":"Freight test employee"}'),
 ('fc000000-0000-4000-8000-000000000003','freight-portal@example.invalid','{"full_name":"Freight test portal"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in('fc000000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000002') and r.code='administrator';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select u.id,p.id,'allow','Synthetic freight test','fc000000-0000-4000-8000-000000000001' from auth.users u cross join public.permissions p
 where u.id in('fc000000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000002')
 and p.code in('carriers.directory.read','carriers.directory.manage','freight.context.read','freight.context.manage','drivers.documents.view')
 and (u.id='fc000000-0000-4000-8000-000000000001' or p.code<>'drivers.documents.view');
-- Administrators hold drivers.documents.view through their role (202611150100). The second
-- administrator stands for an employee without that right, so a personal deny removes it.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'fc000000-0000-4000-8000-000000000002',id,'deny','Synthetic employee without driver documents','fc000000-0000-4000-8000-000000000001'
 from public.permissions where code='drivers.documents.view';
insert into public.counterparties(id,roles,legal_name,country) values
 ('fc100000-0000-4000-8000-000000000001',array['carrier'],'Тестовый перевозчик А','KZ'),
 ('fc100000-0000-4000-8000-000000000002',array['carrier'],'Тестовый перевозчик Б','KZ'),
 ('fc100000-0000-4000-8000-000000000003',array['manufacturer','supplier'],'Тестовый завод','DE'),
 ('fc100000-0000-4000-8000-000000000004',array['customer'],'Тестовый покупатель','KZ');
update public.profiles set user_type='external',counterparty_id='fc100000-0000-4000-8000-000000000004' where id='fc000000-0000-4000-8000-000000000003';
set session_replication_role=replica;
insert into public.shipments(id,shipment_number,project_code,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
 values('fc200000-0000-4000-8000-000000000001','TEST-FREIGHT-IMPORT','TEST-FREIGHT','import','fc100000-0000-4000-8000-000000000003',
 (select id from public.routes limit 1),(select id from public.process_templates limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where code='AKT'),'fc000000-0000-4000-8000-000000000001','fc000000-0000-4000-8000-000000000001');
insert into public.shipment_transports(id,shipment_id,sequence_no,driver_name,driver_phone,driver_document,vehicle_plate,carrier_name)
 values('fc210000-0000-4000-8000-000000000001','fc200000-0000-4000-8000-000000000001',1,'Источник Водитель','+7 000 000 0000','SECRET-DOC-123','ABC-123','Тестовый перевозчик А');
insert into public.sales(id,sale_number,customer_id,warehouse_id,planned_shipment_date,created_by)
 select id::uuid,label,'fc100000-0000-4000-8000-000000000004',(select id from public.warehouses where code='AKT'),current_date+5,'fc000000-0000-4000-8000-000000000001'
 from (values('fc300000-0000-4000-8000-000000000001','TEST-FREIGHT-SALE-1'),('fc300000-0000-4000-8000-000000000002','TEST-FREIGHT-SALE-2')) v(id,label);
insert into public.inventory_operation_documents(id,document_number,operation_type,from_warehouse_id,to_warehouse_id,created_by)
 select id::uuid,label,'transfer',(select id from public.warehouses where code='AKT'),(select id from public.warehouses where code='AST'),'fc000000-0000-4000-8000-000000000001'
 from (values('fc400000-0000-4000-8000-000000000001','TEST-FREIGHT-MOVE-1'),('fc400000-0000-4000-8000-000000000002','TEST-FREIGHT-MOVE-2')) v(id,label);
set session_replication_role=origin;
create table tests.freight_ids(k text primary key,id uuid,value jsonb);
grant select,insert,update,delete on tests.freight_ids to authenticated;
create or replace function tests.freight_fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'Expected %, got %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'Expected refusal %, but operation succeeded',p_pattern;
end$$;
grant execute on function tests.freight_fails(text,text) to authenticated;
create or replace function tests.freight_business() returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('shipments',(select jsonb_agg(to_jsonb(t) order by id) from public.shipments t),
 'transport',(select jsonb_agg(to_jsonb(t) order by id) from public.shipment_transports t),
 'sales',(select jsonb_agg(to_jsonb(t) order by id) from public.sales t),
 'stock',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_balances t),
 'movements',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_movements t),
 'reserves',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_reservations t),
 'expenses',(select jsonb_agg(to_jsonb(t) order by id) from public.expenses t),
 'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.documents t))
$$;
grant execute on function tests.freight_business() to authenticated;
