-- Runs on the schema BEFORE 202609278800_batch_cost_by_receipt.sql and proves the defects it fixes: one batch is
-- received by two shipments (10 boxes, then 60 pieces). Approving the first shipment gives the whole batch its price
-- per box, the pieces of the second included; approving the second changes nothing.
-- Everything is rolled back. supabase/tests/batch_cost_by_receipt.test.sql proves the weighted average afterwards.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('dc000000-0000-4000-8000-000000000101','batch-cost-before-director@test.local','{"full_name":"Batch Cost Director"}'),
 ('dc000000-0000-4000-8000-000000000102','batch-cost-before-blind@test.local','{"full_name":"Batch Cost Blind"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('dc000000-0000-4000-8000-000000000101'::uuid,'director'),('dc000000-0000-4000-8000-000000000102'::uuid,'director')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'dc000000-0000-4000-8000-000000000102',id,'deny','batch cost test','dc000000-0000-4000-8000-000000000101' from public.permissions where code='prices.purchase.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('dc100000-0000-4000-8000-000000000101',array['manufacturer','supplier'],'Batch cost supplier','FI','BCB-SUP');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('dc200000-0000-4000-8000-000000000101','BCB-BOX12','{"ru":"Коробка по 12"}','dc100000-0000-4000-8000-000000000101','active'),
 ('dc200000-0000-4000-8000-000000000102','BCB-NOPACK','{"ru":"Без упаковки"}','dc100000-0000-4000-8000-000000000101','active'),
 ('dc200000-0000-4000-8000-000000000103','BCB-BOXES','{"ru":"Только коробки"}','dc100000-0000-4000-8000-000000000101','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values('dc200000-0000-4000-8000-000000000101','box',12);
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official',current_date-30,
 'dc000000-0000-4000-8000-000000000101';

create temporary table bc(k text primary key,shipment uuid,transport uuid,item uuid,item2 uuid);
grant select,insert,update on bc to authenticated;
create function pg_temp.batch(p_number text) returns public.inventory_batches language sql stable as $$
 select * from public.inventory_batches where batch_number=p_number $$;
create function pg_temp.batch_id(p_number text) returns uuid language sql stable as $$
 select id from public.inventory_batches where batch_number=p_number $$;
grant execute on function pg_temp.batch_id(text) to authenticated;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
-- one shipment with one truck, its items allocated to the truck and received into the named batches
create function pg_temp.receive(p_key text,p_lines jsonb) returns void language plpgsql as $$
declare v_shipment uuid; v_transport uuid; v_line jsonb; v_item uuid; v_items jsonb:='[]';
begin
 v_shipment:=public.create_shipment_with_stages(p_key,'import','dc100000-0000-4000-8000-000000000101',null,
  (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'dc000000-0000-4000-8000-000000000101',current_date,current_date+14);
 perform public.add_shipment_transport(v_shipment);
 select id into v_transport from public.shipment_transports where shipment_id=v_shipment and sequence_no=1;
 for v_line in select * from jsonb_array_elements(p_lines) loop
  v_item:=public.create_shipment_item(v_shipment,(v_line->>'product')::uuid,v_line->>'uom',(v_line->>'qty')::numeric,(v_line->>'price')::numeric,
   (select id from public.currencies where code='EUR'));
  v_item:=public.allocate_shipment_item(v_item,v_transport,(v_line->>'qty')::numeric);
  v_items:=v_items||jsonb_build_object('item_id',v_item,'accepted_quantity',(v_line->>'qty')::numeric,'batch_number',v_line->>'batch',
   'expiry_date',(current_date+300)::text);
  insert into bc(k,shipment,transport,item) values(p_key||':'||(v_line->>'batch'),v_shipment,v_transport,v_item);
 end loop;
 insert into bc(k,shipment,transport) values(p_key,v_shipment,v_transport);
 perform public.change_shipment_transport_status(v_transport,'arrived');
 perform public.receive_shipment_transport(v_transport,null,v_items,'Кладовщик');
end $$;
grant execute on function pg_temp.receive(text,jsonb) to authenticated;
create function pg_temp.approve(p_key text) returns void language plpgsql as $$
begin
 perform public.approve_shipment_cost(public.calculate_shipment_cost((select shipment from bc where k=p_key),(select id from public.currencies where code='KZT')));
end $$;
grant execute on function pg_temp.approve(text) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000101',false);
select pg_temp.receive('B1','[{"product":"dc200000-0000-4000-8000-000000000101","uom":"box","qty":10,"price":24,"batch":"BCB-MIX"}]');
select pg_temp.receive('B2','[{"product":"dc200000-0000-4000-8000-000000000101","uom":"piece","qty":60,"price":2.5,"batch":"BCB-MIX"}]');
select pg_temp.approve('B1');
reset role;
do $$ begin
 assert (pg_temp.batch('BCB-MIX')).unit_landed_cost=12000,
  'BEFORE: the first approval prices the whole batch at 12 000 a box, the 60 pieces of the second shipment included';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000101',false);
select pg_temp.approve('B2');
reset role;
do $$ begin
 assert (pg_temp.batch('BCB-MIX')).unit_landed_cost=12000,
  'BEFORE: approving the second shipment leaves the batch at the price of the first';
end $$;

rollback;
