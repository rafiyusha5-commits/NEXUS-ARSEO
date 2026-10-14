-- Runs on the schema BEFORE 202609278100_confirmed_order_recovery.sql and proves the dead end it removes.
-- Everything is rolled back. supabase/tests/confirmed_order_recovery.test.sql proves the way out afterwards.
-- A confirmed order cannot be shipped and cannot be repaired, only cancelled, when after confirmation
--   1. its batch is blocked (and a reserved order on a blocked batch can even be confirmed),
--   2. its batch expires before the shipment,
--   3. the shipment is delayed and the remaining shelf life falls below the client's requirement.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c5000000-0000-4000-8000-000000000001','order-before@test.local','{"full_name":"Order Before"}');
insert into public.user_roles(user_id,role_id) select 'c5000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c5100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Order before factory','FI','OB-M'),
 ('c5100000-0000-4000-8000-000000000002',array['customer'],'Order before buyer','KZ','OB-C');
insert into public.warehouses(id,code,name,city,country) values
 ('c5200000-0000-4000-8000-000000000001','OB-WH','{"ru":"Склад до исправления"}','Актобе','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('c5300000-0000-4000-8000-000000000001','OB-BLOCK','{"ru":"Товар для блокировки"}','c5100000-0000-4000-8000-000000000001',400),
 ('c5300000-0000-4000-8000-000000000002','OB-EXPIRE','{"ru":"Товар, который просрочится"}','c5100000-0000-4000-8000-000000000001',400),
 ('c5300000-0000-4000-8000-000000000003','OB-DELAY','{"ru":"Товар со сроком 100 дней"}','c5100000-0000-4000-8000-000000000001',100);
-- Every product has a second, fresh batch: stock to repair the order exists.
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('c5400000-0000-4000-8000-000000000001','c5300000-0000-4000-8000-000000000001','OB-BLOCK-1',current_date-10,current_date+200,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000002','c5300000-0000-4000-8000-000000000001','OB-BLOCK-2',current_date-10,current_date+250,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000003','c5300000-0000-4000-8000-000000000002','OB-EXPIRE-1',current_date-10,current_date+100,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000004','c5300000-0000-4000-8000-000000000002','OB-EXPIRE-2',current_date-10,current_date+200,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000005','c5300000-0000-4000-8000-000000000003','OB-DELAY-1',current_date-20,current_date+80,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000006','c5300000-0000-4000-8000-000000000003','OB-DELAY-2',current_date-5,current_date+95,'c5000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select id,'c5200000-0000-4000-8000-000000000001','piece',100 from public.inventory_batches where batch_number like 'OB-%';
create temporary table ob(k text primary key,id uuid);
grant all on ob to authenticated;

create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
 execute p_sql;
 raise exception 'expected a failure: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;
 when others then
  if position(p_expected in sqlerrm)=0 and sqlstate<>p_expected then raise exception 'unexpected error for %: % (%)',p_sql,sqlerrm,sqlstate;end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','c5000000-0000-4000-8000-000000000001',false);
-- Three confirmed orders of 10 pieces, shipment in 5 days; the delay product needs 74 % remaining shelf life (75 % reserved).
insert into ob select 'sale-'||p.k,public.create_customer_order('c5100000-0000-4000-8000-000000000002',null,'c5200000-0000-4000-8000-000000000001',current_date+5,null,'До исправления '||p.k)
from (values('block'),('expire'),('delay'),('unconfirmed'))p(k);
insert into ob select 'item-'||p.k,public.add_customer_order_item((select id from ob where k='sale-'||p.k),p.product::uuid,10,'piece',null,p.required)
from (values('block','c5300000-0000-4000-8000-000000000001',null::numeric),('expire','c5300000-0000-4000-8000-000000000002',null),
 ('delay','c5300000-0000-4000-8000-000000000003',74),('unconfirmed','c5300000-0000-4000-8000-000000000001',null))p(k,product,required);
select public.reserve_customer_order_item_fefo(id) from ob where k like 'item-%';
select public.confirm_customer_order(id) from ob where k in ('sale-block','sale-expire','sale-delay');
do $$begin
 assert (select remaining_shelf_life_pct=75 from public.inventory_reservations where sale_item_id=(select id from ob where k='item-delay') and status='active'),
  '75 % remaining at the planned date';
end$$;

-- 1. The batch is blocked after confirmation.
select public.set_inventory_batch_status('c5400000-0000-4000-8000-000000000001','blocked','Отзыв производителя');
select pg_temp.expect_failure(format('select public.fulfill_customer_order(%L)',(select id from ob where k='sale-block')),'Партия заблокирована');
select pg_temp.expect_failure(format('select public.reserve_customer_order_item_fefo(%L)',(select id from ob where k='item-block')),'Заказ недоступен для резервирования');
select pg_temp.expect_failure(format('select public.reserve_customer_order_item_override(%L,%L,%L)',(select id from ob where k='item-block'),
 (select id from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000002'),'Свежая партия'),'Заказ недоступен для резервирования');
-- A reserved order on the blocked batch is still confirmed, and nobody was told.
select public.confirm_customer_order(id) from ob where k='sale-unconfirmed';
reset role;
do $$begin
 assert (select status='confirmed' from public.sales where id=(select id from ob where k='sale-unconfirmed')),'before the fix confirmation ignores the blocked batch';
 assert not exists(select 1 from public.notifications where entity_id in (select id from ob where k like 'sale-%')),'and blocking warns nobody';
end$$;

-- 2. The batch expires before the shipment.
update public.inventory_batches set expiry_date=current_date-1 where id='c5400000-0000-4000-8000-000000000003';
set role authenticated;
select set_config('request.jwt.claim.sub','c5000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.fulfill_customer_order(%L)',(select id from ob where k='sale-expire')),'просрочена');
select pg_temp.expect_failure(format('select public.reserve_customer_order_item_fefo(%L)',(select id from ob where k='item-expire')),'Заказ недоступен для резервирования');

-- 3. The shipment slips by two days: 73 % is below the 74 % the client requires, and no guarantee letter can be issued.
reset role;
update public.sales set planned_shipment_date=current_date+7 where id=(select id from ob where k='sale-delay');
set role authenticated;
select set_config('request.jwt.claim.sub','c5000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.fulfill_customer_order(%L)',(select id from ob where k='sale-delay')),'гарантийного письма');
select pg_temp.expect_failure(format('select public.create_sale_guarantee_letter(%L,%L)',(select id from ob where k='sale-delay'),'Задержка'),'Заказ недоступен для гарантийного письма');
do $$begin
 assert to_regprocedure('public.reschedule_customer_order(uuid,date,text)') is null and to_regprocedure('public.rereserve_customer_order_item(uuid,uuid,text)') is null,
  'before the fix there is no way to move the date or replace the batches of a confirmed order';
end$$;
-- The only way out is to cancel the whole order.
select public.cancel_customer_order(id,'Тупик') from ob where k='sale-delay';

reset role;
rollback;
