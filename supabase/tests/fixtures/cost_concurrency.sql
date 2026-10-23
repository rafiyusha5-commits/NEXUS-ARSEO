-- Audit findings Н3 and Н4: items without a receipt, planned versus actual expenses, cancellation and reversal.
-- supabase/tests/before/202609278000_expense_cancel_costing.sql shows the same scenarios failing before the fix.
\set ON_ERROR_STOP 1


insert into auth.users(id,email,raw_user_meta_data) values
 ('ed000000-0000-4000-8000-000000000001','cost-race-director@test.local','{"full_name":"Cost Director"}'),
 ('ed000000-0000-4000-8000-000000000002','cost-race-accountant@test.local','{"full_name":"Cost Accountant"}'),
 ('ed000000-0000-4000-8000-000000000003','cost-race-logistic@test.local','{"full_name":"Cost Logistic"}'),
 ('ed000000-0000-4000-8000-000000000004','cost-race-no-prices@test.local','{"full_name":"Cost Without Prices"}'),
 ('ed000000-0000-4000-8000-000000000005','cost-race-no-payments@test.local','{"full_name":"Cost Without Payments"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values('ed000000-0000-4000-8000-000000000001','director'),('ed000000-0000-4000-8000-000000000002','accountant'),
 ('ed000000-0000-4000-8000-000000000003','logistics_specialist'),('ed000000-0000-4000-8000-000000000004','accountant'),
 ('ed000000-0000-4000-8000-000000000005','accountant'))u(id,code)
join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select u.id::uuid,p.id,'deny','cost test','ed000000-0000-4000-8000-000000000001'
from (values('ed000000-0000-4000-8000-000000000004','prices.purchase.view'),('ed000000-0000-4000-8000-000000000005','finance.pay'))u(id,code)
join public.permissions p on p.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ed100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Cost supplier','FI','COST-RACE-SUP'),
 ('ed100000-0000-4000-8000-000000000002',array['carrier'],'Cost carrier','KZ','COST-RACE-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ed200000-0000-4000-8000-000000000001','COST-RACE-A','{"ru":"Товар А"}','ed100000-0000-4000-8000-000000000001','active'),
 ('ed200000-0000-4000-8000-000000000002','COST-RACE-B','{"ru":"Товар Б"}','ed100000-0000-4000-8000-000000000001','active');
-- Only product A has a weight: product B must not be needed for allocation when it did not arrive.
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg) values('ed200000-0000-4000-8000-000000000001','piece',1,1.5);
select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.number,'import','ed100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),
 (select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual limit 1),'ed000000-0000-4000-8000-000000000003','ed000000-0000-4000-8000-000000000001'
from (values('ed300000-0000-4000-8000-000000000001','COST-RACE-1'),('ed300000-0000-4000-8000-000000000002','COST-RACE-2'),
 ('ed300000-0000-4000-8000-000000000003','COST-RACE-3'),('ed300000-0000-4000-8000-000000000004','COST-RACE-4'))s(id,number);
-- COST-RACE-1: A arrived, B (no price, no weight) did not arrive. COST-RACE-2: nothing arrived. COST-RACE-3: A arrived.
-- COST-RACE-4: not received yet; quantities come from the order.
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id)
select i.id::uuid,i.shipment::uuid,i.product::uuid,'piece',i.ordered,i.received,i.price,(select id from public.currencies where code='EUR') from (values
 ('ed400000-0000-4000-8000-000000000001','ed300000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001',10,10,2.0),
 ('ed400000-0000-4000-8000-000000000002','ed300000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000002',10,0,null),
 ('ed400000-0000-4000-8000-000000000003','ed300000-0000-4000-8000-000000000002','ed200000-0000-4000-8000-000000000001',10,0,2.0),
 ('ed400000-0000-4000-8000-000000000004','ed300000-0000-4000-8000-000000000003','ed200000-0000-4000-8000-000000000001',10,10,2.0),
 ('ed400000-0000-4000-8000-000000000005','ed300000-0000-4000-8000-000000000004','ed200000-0000-4000-8000-000000000001',10,null,2.0),
 ('ed400000-0000-4000-8000-000000000006','ed300000-0000-4000-8000-000000000004','ed200000-0000-4000-8000-000000000002',5,null,2.0))i(id,shipment,product,ordered,received,price);
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('ed500000-0000-4000-8000-000000000001','ed200000-0000-4000-8000-000000000001','ed400000-0000-4000-8000-000000000004','COST-RACE-LOT-3','2027-12-31','ed000000-0000-4000-8000-000000000001');


