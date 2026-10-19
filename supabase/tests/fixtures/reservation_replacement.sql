-- Synthetic ONLY; safe to load in a disposable cluster. No external services or trigger disabling.
create schema if not exists tests;
create table tests.rr_context(k text primary key,id uuid);
grant usage on schema tests to authenticated;
grant all on tests.rr_context to authenticated;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ee000000-0000-4000-8000-000000000001','replacement@example.invalid','{"full_name":"Synthetic replacement"}');
insert into public.user_roles(user_id,role_id) select 'ee000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('ee100000-0000-4000-8000-000000000001',array['supplier','manufacturer'],'Synthetic RR factory','FI','RR-M',null),
 ('ee100000-0000-4000-8000-000000000002',array['customer'],'Synthetic RR buyer','KZ','RR-C',60);
insert into public.warehouses(id,code,name,city,country) values
 ('ee200000-0000-4000-8000-000000000001','SYNTH-RR','{"ru":"Тестовый склад"}','Synthetic','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('ee300000-0000-4000-8000-000000000001','SYNTH-RR','{"ru":"Тестовый товар"}','ee100000-0000-4000-8000-000000000001',400);
insert into public.product_packaging(product_id,uom,units_per_parent) values ('ee300000-0000-4000-8000-000000000001','box',10);
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('ee400000-0000-4000-8000-000000000001','ee300000-0000-4000-8000-000000000001','RR-OLD','2098-11-01','2099-12-06','ee000000-0000-4000-8000-000000000001'),
 ('ee400000-0000-4000-8000-000000000002','ee300000-0000-4000-8000-000000000001','RR-NEW-A','2098-11-01','2099-11-06','ee000000-0000-4000-8000-000000000001'),
 ('ee400000-0000-4000-8000-000000000003','ee300000-0000-4000-8000-000000000001','RR-NEW-B','2098-11-01','2099-12-06','ee000000-0000-4000-8000-000000000001'),
 ('ee400000-0000-4000-8000-000000000004','ee300000-0000-4000-8000-000000000001','RR-LOW','2098-04-01','2099-03-06','ee000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ee500000-0000-4000-8000-000000000001','ee400000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000001','piece',100),
 ('ee500000-0000-4000-8000-000000000002','ee400000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000001','piece',10),
 ('ee500000-0000-4000-8000-000000000003','ee400000-0000-4000-8000-000000000003','ee200000-0000-4000-8000-000000000001','piece',10),
 ('ee500000-0000-4000-8000-000000000004','ee400000-0000-4000-8000-000000000004','ee200000-0000-4000-8000-000000000001','piece',100);
set role authenticated;
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',false);
insert into tests.rr_context values ('sale',public.create_customer_order('ee100000-0000-4000-8000-000000000002',null,'ee200000-0000-4000-8000-000000000001','2099-01-20',null,'Synthetic replacement'));
insert into tests.rr_context select 'item',public.add_customer_order_item(id,'ee300000-0000-4000-8000-000000000001',2,'box',null,60) from tests.rr_context where k='sale';
select public.reserve_customer_order_item_override(id,'ee500000-0000-4000-8000-000000000001','Synthetic setup') from tests.rr_context where k='item';
select public.confirm_customer_order(id) from tests.rr_context where k='sale';
insert into tests.rr_context values ('other',public.create_customer_order('ee100000-0000-4000-8000-000000000002',null,'ee200000-0000-4000-8000-000000000001','2099-01-20',null,'Synthetic other'));
insert into tests.rr_context select 'other-item',public.add_customer_order_item(id,'ee300000-0000-4000-8000-000000000001',2,'box',null,60) from tests.rr_context where k='other';
select public.reserve_customer_order_item_override(id,'ee500000-0000-4000-8000-000000000001','Synthetic setup') from tests.rr_context where k='other-item';
select public.confirm_customer_order(id) from tests.rr_context where k='other';
select public.set_inventory_batch_status('ee400000-0000-4000-8000-000000000001','blocked','Synthetic blocked old batch');
reset role;
create function tests.rr_plan(p_key text default 'item') returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('item_id',id,'balance_id','ee500000-0000-4000-8000-000000000002','sale_quantity',1),
 jsonb_build_object('item_id',id,'balance_id','ee500000-0000-4000-8000-000000000003','sale_quantity',1)) from tests.rr_context where k=p_key
$$;
grant execute on function tests.rr_plan(text) to authenticated;
