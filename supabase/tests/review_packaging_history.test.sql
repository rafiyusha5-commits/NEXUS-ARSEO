-- Returns from customers (202609277500): only against a shipped order, never more than shipped per line and batch,
-- quarantine outside the sellable stock, decisions with the right permissions, cancellation.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ee000000-0000-4000-8000-000000000001','returns-director@test.local','{"full_name":"Returns Director"}'),
 ('ee000000-0000-4000-8000-000000000002','returns-viewer@test.local','{"full_name":"Returns Viewer"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ee000000-0000-4000-8000-000000000001'),('ee000000-0000-4000-8000-000000000002')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ee000000-0000-4000-8000-000000000002'::uuid,p.id,'deny','returns test','ee000000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('sales.returns','inventory.receive','inventory.write_off');
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ee100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Returns Supplier','FI','RET-SUP'),
 ('ee100000-0000-4000-8000-000000000002',array['customer'],'Returns Customer','KZ','RET-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ee200000-0000-4000-8000-000000000001','RET-001','{"ru":"Товар для возврата"}','ee100000-0000-4000-8000-000000000001','active',400);

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table rt(name text primary key,id uuid);
grant select,insert,update on rt to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from rt where name=p_name $$;
grant execute on function pg_temp.id(text) to authenticated;

insert into rt select 'warehouse',id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('ee300000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000001','RET-EARLY',current_date-100,current_date+200,'ee000000-0000-4000-8000-000000000001'),
 ('ee300000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000001','RET-LATE',current_date-50,current_date+300,'ee000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ee400000-0000-4000-8000-000000000001','ee300000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',60),
 ('ee400000-0000-4000-8000-000000000002','ee300000-0000-4000-8000-000000000002',pg_temp.id('warehouse'),'piece',100);


update public.inventory_batches set manufacture_date=current_date-10 where product_id='ee200000-0000-4000-8000-000000000001';
insert into public.product_packaging(product_id,uom,units_per_parent) values('ee200000-0000-4000-8000-000000000001','box',12);
set role authenticated;
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',false);
insert into rt select 'sale',public.create_customer_order('ee100000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item',public.add_customer_order_item(pg_temp.id('sale'),'ee200000-0000-4000-8000-000000000001',2,'box',100,null,'Синтетическая цена теста');
select public.reserve_customer_order_item_fefo(pg_temp.id('item'));
select public.confirm_customer_order(pg_temp.id('sale'));
select public.fulfill_customer_order(pg_temp.id('sale'));
select 'BEFORE' as phase,public.customer_return_options(pg_temp.id('sale'));
reset role;
select 'DEBT_BEFORE' as phase,* from private.sale_amount(pg_temp.id('sale'));
update public.product_packaging set units_per_parent=6 where product_id='ee200000-0000-4000-8000-000000000001' and uom='box';
select 'DEBT_AFTER' as phase,* from private.sale_amount(pg_temp.id('sale'));
set role authenticated;
select 'AFTER' as phase,public.customer_return_options(pg_temp.id('sale'));


do $$ declare options jsonb; begin
 options:=public.customer_return_options(pg_temp.id('sale'));
 assert (options->0->>'shipped')::numeric=2, 'Packaging edits must not rewrite shipped boxes';
 assert (options->0->>'available')::numeric=2, 'Packaging edits must not enlarge returns';
end $$;
reset role;
do $$ begin
 assert (select amount=200 from private.sale_amount(pg_temp.id('sale'))), 'Packaging edits must not reprice debt';
end $$;
rollback;
