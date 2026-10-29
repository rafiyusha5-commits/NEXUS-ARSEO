-- The cost of a batch is the weighted average of its receipts (202609278800, audit finding Н6): one batch received by
-- two shipments, in boxes and in pieces, gets no cost until both are approved, then the average per piece; a batch
-- received in one unit is costed in that unit; a new receipt waits for its approval; the reader states unit and currency.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('dc000000-0000-4000-8000-000000000001','batch-cost-director@test.local','{"full_name":"Batch Cost Director"}'),
 ('dc000000-0000-4000-8000-000000000002','batch-cost-blind@test.local','{"full_name":"Batch Cost Blind"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('dc000000-0000-4000-8000-000000000001'::uuid,'director'),('dc000000-0000-4000-8000-000000000002'::uuid,'director')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'dc000000-0000-4000-8000-000000000002',id,'deny','batch cost test','dc000000-0000-4000-8000-000000000001' from public.permissions where code='prices.purchase.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('dc100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Batch cost supplier','FI','BC-SUP');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('dc200000-0000-4000-8000-000000000001','BC-BOX12','{"ru":"Коробка по 12"}','dc100000-0000-4000-8000-000000000001','active'),
 ('dc200000-0000-4000-8000-000000000002','BC-NOPACK','{"ru":"Без упаковки"}','dc100000-0000-4000-8000-000000000001','active'),
 ('dc200000-0000-4000-8000-000000000003','BC-BOXES','{"ru":"Только коробки"}','dc100000-0000-4000-8000-000000000001','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values('dc200000-0000-4000-8000-000000000001','box',12);
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official',current_date-30,
 'dc000000-0000-4000-8000-000000000001';

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
 v_shipment:=public.create_shipment_with_stages(p_key,'import','dc100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),(select id from public.currencies where code='EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),'dc000000-0000-4000-8000-000000000001',current_date,current_date+14);
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
create function pg_temp.approve_in(p_key text,p_currency text) returns void language plpgsql as $$
begin
 perform public.approve_shipment_cost(public.calculate_shipment_cost((select shipment from bc where k=p_key),(select id from public.currencies where code=p_currency)));
end $$;
grant execute on function pg_temp.approve_in(text,text) to authenticated;

set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
-- S1 brings 10 boxes (24 EUR a box) of BC-MIX and 5 boxes (30 EUR) of BC-ONE; S2 brings 60 pieces (2.5 EUR) of BC-MIX
select pg_temp.receive('S1','[{"product":"dc200000-0000-4000-8000-000000000001","uom":"box","qty":10,"price":24,"batch":"BC-MIX"},
 {"product":"dc200000-0000-4000-8000-000000000003","uom":"box","qty":5,"price":30,"batch":"BC-ONE"}]');
select pg_temp.receive('S2','[{"product":"dc200000-0000-4000-8000-000000000001","uom":"piece","qty":60,"price":2.5,"batch":"BC-MIX"}]');

-- ---------- 1. the first approval does not price the goods of the second shipment ----------
select pg_temp.approve('S1');
reset role;
do $$ begin
 assert (pg_temp.batch('BC-MIX')).unit_landed_cost is null and (pg_temp.batch('BC-MIX')).cost_uom is null,
  format('BC-MIX waits for S2: %s',row_to_json(pg_temp.batch('BC-MIX')));
 assert (pg_temp.batch('BC-ONE')).unit_landed_cost=15000 and (pg_temp.batch('BC-ONE')).cost_uom='box',
  format('BC-ONE, received in boxes only, costs 30 x 500 per box: %s',row_to_json(pg_temp.batch('BC-ONE')));
end $$;

-- ---------- 2. the second approval gives the weighted average per piece ----------
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
select pg_temp.approve('S2');
reset role;
do $$ declare b public.inventory_batches; begin
 b:=pg_temp.batch('BC-MIX');
 -- (10 boxes x 12 000 + 60 pieces x 1 250) / (120 + 60 pieces)
 assert b.unit_landed_cost=round(195000/180.0,4) and b.cost_uom='piece' and b.cost_currency_id=(select id from public.currencies where code='KZT'),
  format('BC-MIX costs the average per piece: %s',row_to_json(b));
 assert b.cost_calculation_id=(select id from public.cost_calculations where shipment_id=(select shipment from bc where k='S2') and status='approved'),
  'the latest approved calculation is named';
end $$;

-- ---------- 3. the reader states the unit and the currency; prices stay closed ----------
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
do $$ begin
 assert (select cost_uom='piece' and cost_currency_code='KZT' and unit_landed_cost=round(195000/180.0,4)
   from public.my_batch_landed_costs('dc200000-0000-4000-8000-000000000001') where batch_id=pg_temp.batch_id('BC-MIX')),'the reader states unit and currency';
 assert (select unit_landed_cost=15000 from public.my_inventory_batch_costs('dc200000-0000-4000-8000-000000000001')
   where batch_id=pg_temp.batch_id('BC-ONE')) is null,'BC-ONE is not in the list of BC-BOX12';
 assert (select unit_landed_cost=15000 from public.my_inventory_batch_costs('dc200000-0000-4000-8000-000000000003')
   where batch_id=pg_temp.batch_id('BC-ONE')),'the former reader keeps its shape';
end $$;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select * from public.my_batch_landed_costs(null)$$,'Нет доступа к себестоимости');

-- ---------- 4. a new receipt waits for its approval; a batch of a product without packaging in two units has no cost ----------
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
select pg_temp.receive('S3','[{"product":"dc200000-0000-4000-8000-000000000003","uom":"box","qty":2,"price":40,"batch":"BC-ONE"},
 {"product":"dc200000-0000-4000-8000-000000000002","uom":"box","qty":3,"price":10,"batch":"BC-NOPACK"}]');
select pg_temp.receive('S4','[{"product":"dc200000-0000-4000-8000-000000000002","uom":"piece","qty":7,"price":1,"batch":"BC-NOPACK"}]');
reset role;
do $$ begin
 assert (pg_temp.batch('BC-ONE')).unit_landed_cost is null,'BC-ONE waits for the approval of S3';
end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','dc000000-0000-4000-8000-000000000001',false);
select pg_temp.approve('S3');
select pg_temp.approve('S4');
-- S5 and S6 bring BC-CUR in boxes; their costs are approved in different currencies
select pg_temp.receive('S5','[{"product":"dc200000-0000-4000-8000-000000000003","uom":"box","qty":1,"price":10,"batch":"BC-CUR"}]');
select pg_temp.receive('S6','[{"product":"dc200000-0000-4000-8000-000000000003","uom":"box","qty":1,"price":12,"batch":"BC-CUR"}]');
select pg_temp.approve_in('S5','KZT');
select pg_temp.approve_in('S6','EUR');
reset role;
do $$ begin
 -- (5 boxes x 15 000 + 2 boxes x 20 000) / 7 boxes, in boxes: both receipts are in boxes
 assert (pg_temp.batch('BC-ONE')).unit_landed_cost=round(115000/7.0,4) and (pg_temp.batch('BC-ONE')).cost_uom='box',
  format('BC-ONE averages both receipts per box: %s',row_to_json(pg_temp.batch('BC-ONE')));
 assert (pg_temp.batch('BC-NOPACK')).unit_landed_cost is null and (pg_temp.batch('BC-NOPACK')).cost_uom is null,
  'boxes and pieces of a product without packaging cannot be averaged';
 assert (pg_temp.batch('BC-CUR')).unit_landed_cost is null and (pg_temp.batch('BC-CUR')).cost_currency_id is null,
  'costs in different currencies are not averaged';
end $$;

rollback;
\echo 'batch_cost_by_receipt: all checks passed'
