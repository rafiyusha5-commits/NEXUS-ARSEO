-- Synthetic data ONLY. Caller owns the test transaction / disposable cluster.
create schema if not exists tests;
create table tests.assistant_reserve_context(k text primary key,id uuid);
grant usage on schema tests to authenticated;
grant all on tests.assistant_reserve_context to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('eb000000-8a23-4000-8000-000000000001','reserve@example.invalid','{"full_name":"Synthetic Fulfillment"}');
insert into public.user_roles(user_id,role_id) select 'eb000000-8a23-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('eb100000-8a23-4000-8000-000000000001',array['supplier','manufacturer'],'Synthetic Factory','FI','SYNTH-AR-M',null),
 ('eb100000-8a23-4000-8000-000000000002',array['customer'],'Synthetic Buyer','KZ','SYNTH-AR-C',60);
insert into public.warehouses(id,code,name,city,country) values
 ('eb200000-8a23-4000-8000-000000000001','SYNTH-AR','{"ru":"Вымышленный склад"}','Synthetic City','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('eb300000-8a23-4000-8000-000000000001','SYNTH-AR-P','{"ru":"Вымышленный товар"}','eb100000-8a23-4000-8000-000000000001',400);
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('eb400000-8a23-4000-8000-000000000001','eb300000-8a23-4000-8000-000000000001','SYNTH-EARLY','2098-04-01','2099-05-06','eb000000-8a23-4000-8000-000000000001'),
 ('eb400000-8a23-4000-8000-000000000002','eb300000-8a23-4000-8000-000000000001','SYNTH-LATE','2098-11-01','2099-12-06','eb000000-8a23-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('eb500000-8a23-4000-8000-000000000001','eb400000-8a23-4000-8000-000000000001','eb200000-8a23-4000-8000-000000000001','piece',100),
 ('eb500000-8a23-4000-8000-000000000002','eb400000-8a23-4000-8000-000000000002','eb200000-8a23-4000-8000-000000000001','piece',200);
insert into public.product_packaging(product_id,uom,units_per_parent) values('eb300000-8a23-4000-8000-000000000001','box',12);
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-8a23-4000-8000-000000000001',false);
insert into tests.assistant_reserve_context values ('sale',public.create_customer_order('eb100000-8a23-4000-8000-000000000002',null,'eb200000-8a23-4000-8000-000000000001','2099-01-20',null,'Synthetic order'));
insert into tests.assistant_reserve_context select 'item',public.add_customer_order_item(id,'eb300000-8a23-4000-8000-000000000001',12.5,'box',120,60,'Синтетическая цена') from tests.assistant_reserve_context where k='sale';
insert into tests.assistant_reserve_context select 'second-item',public.add_customer_order_item(id,'eb300000-8a23-4000-8000-000000000001',50,'piece',10,60,'Синтетическая цена') from tests.assistant_reserve_context where k='sale';
reset role;
