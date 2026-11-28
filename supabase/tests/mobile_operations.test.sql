-- 202611280600: warehouse operations from a phone. A move between locations of one warehouse is a posted transfer
-- document (stock checks, reversal, the lock of a counted location); picking takes only the reserved batch from its
-- place and never more than reserved — the database refuses anything else; shipping needs everything picked.
-- Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
set local timezone='UTC';
do $$begin assert current_date<date '2099-01-01','Explicitly revise fixed fixture dates';end$$;
\ir fixtures/order_fulfillment.sql
-- The order: 150 pieces reserved by FEFO — 100 of SYNTH-EARLY (balance ef5…01) and 50 of SYNTH-LATE (ef5…02); the
-- other order holds 50 more of SYNTH-LATE. Both balances get a place.
insert into public.warehouse_locations(id,warehouse_id,code,zone) values
 ('ef600000-0000-4000-8000-000000000001','ef200000-0000-4000-8000-000000000001','PICK-A1','storage'),
 ('ef600000-0000-4000-8000-000000000002','ef200000-0000-4000-8000-000000000001','PICK-A2','storage'),
 ('ef600000-0000-4000-8000-000000000003','ef200000-0000-4000-8000-000000000001','PICK-B1','storage');
insert into public.warehouses(id,code,name,city,country) values ('ef200000-0000-4000-8000-000000000003','SYNTH-FF3','{"ru":"Другой склад"}','Synthetic City','KZ');
insert into public.warehouse_locations(id,warehouse_id,code,zone) values
 ('ef600000-0000-4000-8000-000000000009','ef200000-0000-4000-8000-000000000003','OTHER-A1','storage');
update public.inventory_balances set warehouse_location_id='ef600000-0000-4000-8000-000000000001' where id='ef500000-0000-4000-8000-000000000001';
update public.inventory_balances set warehouse_location_id='ef600000-0000-4000-8000-000000000002' where id='ef500000-0000-4000-8000-000000000002';
insert into auth.users(id,email,raw_user_meta_data) values
 ('ef000000-0000-4000-8000-000000000002','picker@example.invalid','{"full_name":"Picker"}'),
 ('ef000000-0000-4000-8000-000000000003','no-move@example.invalid','{"full_name":"Without moves"}');
insert into public.user_roles(user_id,role_id) select u.id::uuid,r.id from (values
 ('ef000000-0000-4000-8000-000000000002'),('ef000000-0000-4000-8000-000000000003')) u(id) join public.app_roles r on r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select v.u::uuid,p.id,'deny','mobile operations test','ef000000-0000-4000-8000-000000000001'
   from (values ('ef000000-0000-4000-8000-000000000002','sales.override_fefo'),('ef000000-0000-4000-8000-000000000003','inventory.move')) v(u,code)
   join public.permissions p on p.code=v.code;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.reservation(p_batch text) returns uuid language sql stable security definer as $$
 select r.id from public.inventory_reservations r
  where r.sale_item_id=(select id from tests.fulfillment_context where k='item') and r.status='active'
    and r.batch_id=('ef400000-0000-4000-8000-00000000000'||p_batch)::uuid $$;
grant execute on all functions in schema pg_temp to authenticated;

do $$begin
 assert not has_function_privilege('anon','public.move_between_locations(uuid,uuid,numeric,text)','execute');
 assert not has_function_privilege('service_role','public.confirm_pick(uuid,uuid,uuid,numeric)','execute');
 assert not has_table_privilege('authenticated','public.sale_picks','select');
 assert not has_table_privilege('authenticated','public.sale_picks','insert');
end$$;

-- 1. A move between places of one warehouse: a posted transfer document with its ledger, then reversed.
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$
declare v_doc uuid; d record;
begin
 v_doc := public.move_between_locations('ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000003',30,'Ближе к воротам');
 select * into d from public.inventory_operation_documents where id=v_doc;
 assert d.operation_type='transfer' and d.status='posted' and d.from_warehouse_id=d.to_warehouse_id and d.document_number like 'ПРМ-%'
   and d.reason='Ближе к воротам';
 perform set_config('tests.move_doc',v_doc::text,true);
end $$;
reset role;
do $$begin
 assert (select quantity_on_hand from public.inventory_balances where id='ef500000-0000-4000-8000-000000000002')=170;
 assert (select quantity_on_hand from public.inventory_balances where batch_id='ef400000-0000-4000-8000-000000000002'
          and warehouse_location_id='ef600000-0000-4000-8000-000000000003')=30;
 assert (select count(*) from public.inventory_movements where inventory_operation_document_id=current_setting('tests.move_doc')::uuid
          and movement_type='transfer')=2,'one transfer pair: out of A2, into B1';
 -- The reservations stay on their balance: only the free part moves.
 assert (select quantity_reserved from public.inventory_balances where id='ef500000-0000-4000-8000-000000000002')=100;
end $$;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',true);
set local role authenticated;
-- The reserved stock does not move; the same place, a place of another warehouse, a draft line without a place: refused.
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000003',1,null)$q$,'Недостаточный доступный остаток');
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000002',1,null)$q$,'другое место');
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000009',1,null)$q$,'на другом складе');
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000003',0,null)$q$,'больше нуля');
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000002',gen_random_uuid(),1,null)$q$,'Место назначения не найдено');
do $$
declare v_doc uuid;
begin
 v_doc := public.create_inventory_operation_document('transfer',current_date,'ef200000-0000-4000-8000-000000000001','ef200000-0000-4000-8000-000000000001',null,'Внутри склада',null);
 perform pg_temp.fails(format($q$select public.add_inventory_operation_line(%L,'ef500000-0000-4000-8000-000000000002',null,1,null,null)$q$,v_doc),'другое место');
 perform public.remove_inventory_operation_line(public.add_inventory_operation_line(v_doc,'ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000001',1,null,null));
end $$;
-- The reversal of the move returns the stock to its place.
select public.cancel_inventory_operation_document(current_setting('tests.move_doc')::uuid,'Передумали');
reset role;
do $$begin
 assert (select quantity_on_hand from public.inventory_balances where id='ef500000-0000-4000-8000-000000000002')=200;
 assert (select quantity_on_hand from public.inventory_balances where batch_id='ef400000-0000-4000-8000-000000000002'
          and warehouse_location_id='ef600000-0000-4000-8000-000000000003')=0;
end $$;
-- Without the right to move: refused.
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000003',1,null)$q$,'Недостаточно прав для перемещения');
reset role;
-- A place under an inventory count is locked: no move into it until the count is posted or cancelled.
savepoint counted;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v_count uuid := public.create_inventory_count('ef200000-0000-4000-8000-000000000001','partial',true,null,null);
begin
 perform public.set_inventory_count_scope(v_count,array['ef600000-0000-4000-8000-000000000003']::uuid[],null,false,null);
 perform public.start_inventory_count(v_count);
end $$;
select pg_temp.fails($q$select public.move_between_locations('ef500000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000003',5,null)$q$,'Идёт инвентаризация');
reset role;
rollback to counted;

-- 2. Picking: the pick list in the order of places, the reserved batch only, from its place, never more than reserved.
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$
declare v jsonb := public.order_pick_list((select id from tests.fulfillment_context where k='sale'));
begin
 assert v->>'status'='confirmed' and v->>'customer'='Synthetic Buyer' and not (v->>'can_replace')::boolean;
 assert jsonb_array_length(v->'lines')=2;
 assert v->'lines'->0->>'location'='PICK-A1' and v->'lines'->0->>'batch'='SYNTH-EARLY' and (v->'lines'->0->>'quantity')::numeric=100
    and (v->'lines'->0->>'picked')::numeric=0;
 assert v->'lines'->1->>'location'='PICK-A2' and v->'lines'->1->>'batch'='SYNTH-LATE' and (v->'lines'->1->>'quantity')::numeric=50;
end $$;
-- Another batch of the same product for the SYNTH-EARLY reservation: refused, and the message names the right one.
select pg_temp.fails($q$select public.confirm_pick(pg_temp.reservation('1'),'ef400000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000001',10)$q$,
                     'не из резерва заказа: возьмите партию SYNTH-EARLY, место PICK-A1');
select pg_temp.fails($q$select public.confirm_pick(pg_temp.reservation('1'),'ef400000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000002',10)$q$,
                     'зарезервирована на месте PICK-A1');
select pg_temp.fails($q$select public.confirm_pick(pg_temp.reservation('1'),'ef400000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000001',101)$q$,
                     'не больше резерва: осталось 100');
select pg_temp.fails($q$select public.confirm_pick(gen_random_uuid(),'ef400000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000001',1)$q$,'Резерв не найден');
select public.confirm_pick(pg_temp.reservation('1'),'ef400000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000001',60);
select pg_temp.fails($q$select public.confirm_pick(pg_temp.reservation('1'),'ef400000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000001',41)$q$,
                     'осталось 40');
-- Shipping before everything is picked: refused, nothing shipped.
select pg_temp.fails($q$select public.ship_picked_order((select id from tests.fulfillment_context where k='sale'))$q$,'Не всё отобрано: строк осталось 2');
select public.confirm_pick(pg_temp.reservation('1'),'ef400000-0000-4000-8000-000000000001','ef600000-0000-4000-8000-000000000001',40);
select public.confirm_pick(pg_temp.reservation('2'),'ef400000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000002',50);
do $$
declare v jsonb := public.order_pick_list((select id from tests.fulfillment_context where k='sale'));
begin
 assert (select bool_and((l->>'picked')::numeric=(l->>'quantity')::numeric) from jsonb_array_elements(v->'lines') l);
end $$;
reset role;
-- A pick is never changed afterwards.
select pg_temp.fails($q$update public.sale_picks set quantity=1$q$,'не меняется');
select pg_temp.fails($q$delete from public.sale_picks$q$,'не меняется');
-- A pick of an order that is not confirmed and a pick without the right: refused.
savepoint draft_order;
update public.sales set status='reserved' where id=(select id from tests.fulfillment_context where k='other');
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.confirm_pick((select r.id from public.inventory_reservations r where r.sale_item_id=(select id from tests.fulfillment_context where k='other-item')),
                     'ef400000-0000-4000-8000-000000000002','ef600000-0000-4000-8000-000000000002',1)$q$,'только подтверждённый');
reset role;
rollback to draft_order;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.order_pick_list((select id from tests.fulfillment_context where k='sale'))$q$,'Нет права отбирать');
select pg_temp.fails($q$select public.ship_picked_order((select id from tests.fulfillment_context where k='sale'))$q$,'Нет права отбирать');
reset role;

-- 3. Shipping the picked order: the existing fulfillment, the reservations fulfilled, the picks kept.
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v jsonb;
begin
 perform public.ship_picked_order((select id from tests.fulfillment_context where k='sale'));
 v := public.order_pick_list((select id from tests.fulfillment_context where k='sale'));
 assert v->>'status'='shipped' and jsonb_array_length(v->'lines')=0,'no active reservation after shipping';
end $$;
reset role;
do $$begin
 assert (select status from public.sales where id=(select id from tests.fulfillment_context where k='sale'))='shipped';
 assert (select quantity_on_hand from public.inventory_balances where id='ef500000-0000-4000-8000-000000000001')=0;
 assert (select quantity_on_hand from public.inventory_balances where id='ef500000-0000-4000-8000-000000000002')=150;
 assert (select count(*) from public.sale_picks where sale_id=(select id from tests.fulfillment_context where k='sale'))=3;
 assert (select count(*) from public.sale_picks where picked_by='ef000000-0000-4000-8000-000000000002')=3;
end $$;
rollback;
