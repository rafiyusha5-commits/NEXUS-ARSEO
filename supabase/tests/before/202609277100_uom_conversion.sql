-- Runs on the schema BEFORE 202609277100_uom_conversion.sql (scripts/test-db.sh executes
-- supabase/tests/before/<migration>.sql right before that migration) and proves the problem it fixes:
-- stock received in pieces is invisible to an order in boxes, although the packaging says 12 pieces
-- make a box. Everything is rolled back. supabase/tests/uom_conversion.test.sql covers the fix.

\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('f7000000-0000-4000-8000-000000000091','uom-before@test.local','{"full_name":"UOM Before"}');
insert into public.user_roles(user_id,role_id)
select 'f7000000-0000-4000-8000-000000000091',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('f7100000-0000-4000-8000-000000000091',array['manufacturer','supplier'],'UOM Before Supplier','FI','UOM-B-SUP'),
 ('f7100000-0000-4000-8000-000000000092',array['customer'],'UOM Before Customer','KZ','UOM-B-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('f7200000-0000-4000-8000-000000000091','UOM-B-001','{"ru":"Товар в коробах по 12"}','f7100000-0000-4000-8000-000000000091','active',400);
insert into public.product_packaging(product_id,uom,units_per_parent) values
 ('f7200000-0000-4000-8000-000000000091','piece',1),('f7200000-0000-4000-8000-000000000091','box',12);
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('f7300000-0000-4000-8000-000000000091','f7200000-0000-4000-8000-000000000091','UOM-B-1',current_date-10,current_date+300,'f7000000-0000-4000-8000-000000000091');
create temporary table uom_before(warehouse_id uuid,sale_id uuid,item_id uuid);
grant select,insert,update on uom_before to authenticated;
insert into uom_before(warehouse_id) select id from public.warehouses where status='active' and not is_virtual order by code limit 1;
-- 120 pieces = 10 boxes on hand.
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select 'f7300000-0000-4000-8000-000000000091',warehouse_id,'piece',120 from uom_before;

set role authenticated;
select set_config('request.jwt.claim.sub','f7000000-0000-4000-8000-000000000091',false);
update uom_before set sale_id=public.create_customer_order('f7100000-0000-4000-8000-000000000092',null,warehouse_id,current_date+10,
 (select id from public.currencies where code='KZT'),null);
update uom_before set item_id=public.add_customer_order_item(sale_id,'f7200000-0000-4000-8000-000000000091',2,'box',null,null);
do $$ begin
 begin
  perform public.reserve_customer_order_item_fefo((select item_id from uom_before));
  raise exception 'the problem is gone already' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when others then
  assert position('Недостаточный доступный остаток' in sqlerrm)>0,'2 boxes are not found among 120 pieces: '||sqlerrm;
 end;
end $$;

reset role;
rollback;
