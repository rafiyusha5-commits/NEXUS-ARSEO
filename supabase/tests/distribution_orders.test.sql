-- 202611220500: draft client orders from a shipment's distribution — one per customer and shipment, in one
-- transaction, through the order functions (price from the price list), refused without sales.manage. Synthetic data.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'eb000000-0000-4000-8000-000000000003',id,'deny','distribution test','eb000000-0000-4000-8000-000000000001' from public.permissions where code='sales.manage';
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;
create temp table input as select jsonb_build_array(jsonb_build_object('customer_id','eb100000-0000-4000-8000-000000000001',
  'currency_id',(select id from public.currencies where code='EUR'),'planned_shipment_date',(private.business_today()+5)::text,
  'items',jsonb_build_array(jsonb_build_object('product_id','eb200000-0000-4000-8000-000000000001','quantity',120),
                            jsonb_build_object('product_id','eb200000-0000-4000-8000-000000000002','quantity',30)))) orders;
grant select on input to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
-- 1. A date in the past stops the whole press.
select pg_temp.fails($q$select public.create_distribution_orders('eb300000-0000-4000-8000-000000000001','Distribution_123',
 jsonb_set((select orders from input),'{0,planned_shipment_date}','"2020-01-01"'))$q$,'в прошлом');
-- 2. One draft order with the sheet's quantities.
do $$declare r jsonb;begin
 r:=public.create_distribution_orders('eb300000-0000-4000-8000-000000000001','Distribution_123',(select orders from input));
 assert jsonb_array_length(r->'orders')=1 and (r->>'lines')::int=2,r::text;
end $$;
-- 3. The same customer again is refused.
select pg_temp.fails($q$select public.create_distribution_orders('eb300000-0000-4000-8000-000000000001','Distribution_123',(select orders from input))$q$,'уже создан');
-- 4. Without sales.manage nothing is created.
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000003',true);
select pg_temp.fails($q$select public.create_distribution_orders('eb300000-0000-4000-8000-000000000002','Distribution_123',(select orders from input))$q$,'Нет права');
reset role;
do $$declare v_sale uuid;begin
 assert (select count(*) from public.shipment_distribution_orders)=1;
 select sale_id into v_sale from public.shipment_distribution_orders where shipment_id='eb300000-0000-4000-8000-000000000001';
 assert (select status='draft' and warehouse_id=(select id from public.warehouses where code='AKT') and notes like 'Из распределения поставки DQ-1%' from public.sales where id=v_sale);
 assert (select array_agg(quantity::int order by quantity)=array[30,120] from public.sale_items where sale_id=v_sale);
 assert not has_function_privilege('anon','public.create_distribution_orders(uuid,text,jsonb)','execute');
 assert not has_table_privilege('anon','public.shipment_distribution_orders','select');
end $$;
\echo distribution_orders: all checks passed
rollback;
