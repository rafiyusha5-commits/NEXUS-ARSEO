-- 202611250400 (audit 24.11.2026, Б1): a workbook price is in euro. An item without a price gets the price together with
-- the EUR currency; the price of an item in another currency is not changed by the workbook (its quantity can be); an
-- empty workbook price keeps the item's price; without the purchase price right an unchanged price does not block the
-- quantity change. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('eb200000-0000-4000-8000-000000000004','DQ-004','{"ru":"Товар DQ 4"}','eb100000-0000-4000-8000-000000000002','active'),
 ('eb200000-0000-4000-8000-000000000005','DQ-005','{"ru":"Товар DQ 5"}','eb100000-0000-4000-8000-000000000002','active');
-- Item 4 is priced in rubles, item 5 in euro; item 1 (fixture) has no price and no currency.
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,unit_price,currency_id) values
 ('eb400000-0000-4000-8000-000000000004','eb300000-0000-4000-8000-000000000001','eb200000-0000-4000-8000-000000000004','piece',100,100,
  (select id from public.currencies where code='RUB')),
 ('eb400000-0000-4000-8000-000000000005','eb300000-0000-4000-8000-000000000001','eb200000-0000-4000-8000-000000000005','piece',40,2.25,
  (select id from public.currencies where code='EUR'));
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
-- One reviewed change: item, what the page saw, new quantity and price ('' = empty cell).
create function pg_temp.change(p_item text,p_quantity numeric,p_price text) returns jsonb language sql as $$
 select jsonb_build_array(jsonb_build_object('item_id',i.id,'seen_quantity',i.ordered_quantity,'seen_price',coalesce(i.unit_price::text,''),
   'quantity',p_quantity,'price',p_price))
 from public.shipment_items i where i.id=p_item::uuid $$;
grant execute on all functions in schema pg_temp to authenticated;
-- The page reads prices through my_shipment_item_purchase_prices; the test prepares the changes as the owner.
create temp table ch(k text primary key,v jsonb);
insert into ch values
 ('no_price',pg_temp.change('eb400000-0000-4000-8000-000000000001',900,'2.25')),
 ('rub_price',pg_temp.change('eb400000-0000-4000-8000-000000000004',100,'3')),
 ('rub_qty',pg_temp.change('eb400000-0000-4000-8000-000000000004',120,'100')),
 ('eur_empty',pg_temp.change('eb400000-0000-4000-8000-000000000005',45,''));
grant select on ch to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
-- 1. An item without a price gets the workbook price in euro.
select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',(select v from ch where k='no_price'));
-- 2. The price of an item in rubles is not changed; the whole apply stops.
select pg_temp.fails($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',(select v from ch where k='rub_price'))$q$,
 'в другой валюте');
-- 3. Its quantity is changed when the price comes back unchanged (as the page sends it).
select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',(select v from ch where k='rub_qty'));
-- 4. An empty workbook price keeps the euro price.
select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',(select v from ch where k='eur_empty'));
reset role;
do $$
declare v_eur uuid := (select id from public.currencies where code='EUR'); v_rub uuid := (select id from public.currencies where code='RUB');
begin
 assert (select unit_price=2.25 and currency_id=v_eur from public.shipment_items where id='eb400000-0000-4000-8000-000000000001'),
   'the price written from the workbook carries the EUR currency';
 assert (select ordered_quantity=120 and unit_price=100 and currency_id=v_rub from public.shipment_items where id='eb400000-0000-4000-8000-000000000004'),
   'the ruble item: quantity 120, price 100 RUB untouched';
 assert (select ordered_quantity=45 and unit_price=2.25 and currency_id=v_eur from public.shipment_items where id='eb400000-0000-4000-8000-000000000005'),
   'an empty workbook price keeps 2.25 EUR';
end $$;

-- 5. Without the purchase price right: an unchanged price lets the quantity change, a new price is refused.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'eb000000-0000-4000-8000-000000000002',id,'deny','workbook currency test','eb000000-0000-4000-8000-000000000001'
  from public.permissions where code='prices.purchase.view';
insert into ch values
 ('np_qty',pg_temp.change('eb400000-0000-4000-8000-000000000005',50,'2.25')),
 ('np_price',pg_temp.change('eb400000-0000-4000-8000-000000000005',50,'2.5'));
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000002',true);
select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',(select v from ch where k='np_qty'));
reset role;
do $$begin
 assert (select ordered_quantity=50 and unit_price=2.25 from public.shipment_items where id='eb400000-0000-4000-8000-000000000005'),'quantity 50, price kept';
end $$;
update ch set v=pg_temp.change('eb400000-0000-4000-8000-000000000005',55,'2.5') where k='np_price';
set role authenticated;
select pg_temp.fails($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',(select v from ch where k='np_price'))$q$,
 'Нет права изменять закупочную цену');
reset role;
\echo order_workbook_currency: all checks passed
rollback;
