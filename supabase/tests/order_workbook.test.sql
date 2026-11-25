-- 202611220400: the reviewed «Вн расчеты» changes are applied in one transaction through the item functions; an item
-- changed since review, a line split across vehicles, a product already in the shipment, a closed shipment or a user
-- without shipments.update stop the whole apply. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('eb200000-0000-4000-8000-000000000003','DQ-003','{"ru":"Товар DQ 3"}','eb100000-0000-4000-8000-000000000002','active');
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;
create temp table seen as select id,ordered_quantity q,unit_price p from public.shipment_items where shipment_id='eb300000-0000-4000-8000-000000000001';
grant select on seen to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
-- 1. A stale item stops everything: no date, no new line.
select pg_temp.fails(format($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001','2026-12-07',
 '[{"product_id":"eb200000-0000-4000-8000-000000000003","quantity":10,"price":1.5}]',
 '[{"item_id":"eb400000-0000-4000-8000-000000000001","seen_quantity":999,"seen_price":%s,"quantity":900}]')$q$,
 coalesce((select p::text from seen where id='eb400000-0000-4000-8000-000000000001'),'""')),'изменилась после просмотра');
reset role;
do $$begin
 assert (select planned_ready_date from public.shipments where id='eb300000-0000-4000-8000-000000000001') is null,'date not applied';
 assert not exists(select 1 from public.shipment_items where product_id='eb200000-0000-4000-8000-000000000003'),'no new line';
end $$;
set role authenticated;
-- 2. A line split across vehicles and a product already in the shipment are refused.
select pg_temp.fails(format($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,'[]',
 '[{"item_id":"eb400000-0000-4000-8000-000000000002","seen_quantity":%s,"seen_price":%s,"quantity":60}]')$q$,
 (select q from seen where id='eb400000-0000-4000-8000-000000000002'),coalesce((select p::text from seen where id='eb400000-0000-4000-8000-000000000002'),'""')),'изменилась после просмотра');
select pg_temp.fails($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001',null,
 '[{"product_id":"eb200000-0000-4000-8000-000000000001","quantity":10}]','[]')$q$,'уже есть в поставке');
-- 3. The reviewed changes are applied together.
do $$declare r jsonb;begin
 r:=public.apply_order_workbook('eb300000-0000-4000-8000-000000000001','2026-12-07',
  '[{"product_id":"eb200000-0000-4000-8000-000000000003","quantity":10,"price":1.5}]',
  jsonb_build_array(jsonb_build_object('item_id','eb400000-0000-4000-8000-000000000001','seen_quantity',(select q from seen where id='eb400000-0000-4000-8000-000000000001'),
   'seen_price',(select p from seen where id='eb400000-0000-4000-8000-000000000001'),'quantity',900,'price',2.25)));
 assert r=jsonb_build_object('added',1,'updated',1,'ready_date',true),r::text;
end $$;
-- Purchase prices are not readable from the table by the role; check the result as the owner.
reset role;
do $$begin
 assert (select planned_ready_date from public.shipments where id='eb300000-0000-4000-8000-000000000001')='2026-12-07';
 assert (select ordered_quantity=10 and unit_price=1.5 and currency_id=(select id from public.currencies where code='EUR')
   from public.shipment_items where product_id='eb200000-0000-4000-8000-000000000003');
 assert (select ordered_quantity=900 and unit_price=2.25 and currency_id=(select id from public.currencies where code='EUR')
   from public.shipment_items where id='eb400000-0000-4000-8000-000000000001'),'the workbook price is in euro (202611250400)';
end $$;
set role authenticated;
-- 4. Without shipments.update nothing is applied.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000003',true);
select pg_temp.fails($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000001','2026-12-08','[]','[]')$q$,'Недостаточно прав');
reset role;
-- 5. A closed shipment is not changed.
set session_replication_role=replica;
update public.shipments set status='closed',is_locked=true where id='eb300000-0000-4000-8000-000000000002';
set session_replication_role=origin;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select pg_temp.fails($q$select public.apply_order_workbook('eb300000-0000-4000-8000-000000000002','2026-12-08','[]','[]')$q$,'закрыта');
reset role;
do $$begin assert not has_function_privilege('anon','public.apply_order_workbook(uuid,date,jsonb,jsonb)','execute'); end $$;
\echo order_workbook: all checks passed
rollback;
