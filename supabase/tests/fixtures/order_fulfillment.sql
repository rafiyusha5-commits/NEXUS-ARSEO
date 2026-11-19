-- Synthetic data ONLY. Caller owns the test transaction / disposable cluster.
create schema if not exists tests;
create table tests.fulfillment_context(k text primary key,id uuid);
grant usage on schema tests to authenticated;
grant all on tests.fulfillment_context to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ef000000-0000-4000-8000-000000000001','fulfillment@example.invalid','{"full_name":"Synthetic Fulfillment"}');
insert into public.user_roles(user_id,role_id) select 'ef000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('ef100000-0000-4000-8000-000000000001',array['supplier','manufacturer'],'Synthetic Factory','FI','SYNTH-FF-M',null),
 ('ef100000-0000-4000-8000-000000000002',array['customer'],'Synthetic Buyer','KZ','SYNTH-FF-C',60);
insert into public.warehouses(id,code,name,city,country) values
 ('ef200000-0000-4000-8000-000000000001','SYNTH-FF','{"ru":"Вымышленный склад"}','Synthetic City','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('ef300000-0000-4000-8000-000000000001','SYNTH-FF-P','{"ru":"Вымышленный товар"}','ef100000-0000-4000-8000-000000000001',400);
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('ef400000-0000-4000-8000-000000000001','ef300000-0000-4000-8000-000000000001','SYNTH-EARLY','2098-04-01','2099-05-06','ef000000-0000-4000-8000-000000000001'),
 ('ef400000-0000-4000-8000-000000000002','ef300000-0000-4000-8000-000000000001','SYNTH-LATE','2098-11-01','2099-12-06','ef000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ef500000-0000-4000-8000-000000000001','ef400000-0000-4000-8000-000000000001','ef200000-0000-4000-8000-000000000001','piece',100),
 ('ef500000-0000-4000-8000-000000000002','ef400000-0000-4000-8000-000000000002','ef200000-0000-4000-8000-000000000001','piece',200);
set role authenticated;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false);
insert into tests.fulfillment_context values ('sale',public.create_customer_order('ef100000-0000-4000-8000-000000000002',null,'ef200000-0000-4000-8000-000000000001','2099-01-20',null,'Synthetic order'));
insert into tests.fulfillment_context select 'item',public.add_customer_order_item(id,'ef300000-0000-4000-8000-000000000001',150,'piece',10,60,'Синтетическая цена') from tests.fulfillment_context where k='sale';
select public.reserve_customer_order_item_fefo(id) from tests.fulfillment_context where k='item';
insert into tests.fulfillment_context select 'letter',public.create_sale_guarantee_letter(id,'Synthetic approval') from tests.fulfillment_context where k='sale';
select public.change_sale_guarantee_status(id,'approved') from tests.fulfillment_context where k='letter';
select public.confirm_customer_order(id) from tests.fulfillment_context where k='sale';
insert into tests.fulfillment_context values ('other',public.create_customer_order('ef100000-0000-4000-8000-000000000002',null,'ef200000-0000-4000-8000-000000000001','2099-01-20',null,'Synthetic other order'));
insert into tests.fulfillment_context select 'other-item',public.add_customer_order_item(id,'ef300000-0000-4000-8000-000000000001',50,'piece',10,60,'Синтетическая цена') from tests.fulfillment_context where k='other';
select public.reserve_customer_order_item_fefo(id) from tests.fulfillment_context where k='other-item';
select public.confirm_customer_order(id) from tests.fulfillment_context where k='other';
reset role;
