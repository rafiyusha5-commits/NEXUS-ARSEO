-- Minimal diagnostic, NOT an acceptance test blessing current costing.
-- Only run in the disposable pilot cluster; all data rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ed000000-0000-4000-8000-000000000001','historical-cost@example.invalid','{"full_name":"Synthetic Cost Operator"}');
insert into public.user_roles(user_id,role_id)
 select 'ed000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',true);
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ed100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Synthetic Paid Supplier','KZ','SYNTH-PAID');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ed200000-0000-4000-8000-000000000001','SYNTH-PAID-100','{"ru":"Синтетический товар"}','ed100000-0000-4000-8000-000000000001','active');
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
 select 'ed300000-0000-4000-8000-000000000001','SYNTH-PAID-100','import','ed100000-0000-4000-8000-000000000001',
 (select id from public.routes limit 1),(select id from public.process_templates where code='import_eu_kz' and version=1),
 (select id from public.currencies where code='EUR'),(select id from public.warehouses where status='active' and not is_virtual limit 1),
 'ed000000-0000-4000-8000-000000000001','ed000000-0000-4000-8000-000000000001';
-- Already-received state is fixture setup, not evidence of the receiving UI.
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,received_quantity,unit_price,currency_id)
 values ('ed400000-0000-4000-8000-000000000001','ed300000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001','piece',100,100,100,98,10,(select id from public.currencies where code='EUR'));
create temp table diagnostic_ids(k text primary key,id uuid);
grant all on diagnostic_ids to authenticated;
set local role authenticated;
insert into diagnostic_ids select 'goods',public.create_expense('ed300000-0000-4000-8000-000000000001','goods_cost',
 'ed100000-0000-4000-8000-000000000001',1000,(select id from public.currencies where code='EUR'),'2099-01-10',false,null,'Synthetic: paid 100 units at 10');
select public.confirm_expense((select id from diagnostic_ids where k='goods'));
select public.allocate_expense((select id from diagnostic_ids where k='goods'),'by_quantity',(select id from public.currencies where code='EUR'));
select public.mark_expense_paid((select id from diagnostic_ids where k='goods'));
insert into diagnostic_ids select 'cost',public.calculate_shipment_cost('ed300000-0000-4000-8000-000000000001',(select id from public.currencies where code='EUR'));
select 'HISTORICAL_COST='||jsonb_build_object(
 'ordered',100,'received',98,'paid',1000,'expected_unit_cost',10,
 'actual_quantity',i.quantity,'actual_goods',i.goods_amount,'actual_unit_cost',i.unit_landed_cost,
 'owner_rule_satisfied',i.unit_landed_cost=10,
 'expense_status',(select status from public.expenses where id=(select id from diagnostic_ids where k='goods'))
)::text from public.cost_calculation_items i where calculation_id=(select id from diagnostic_ids where k='cost');
rollback;
