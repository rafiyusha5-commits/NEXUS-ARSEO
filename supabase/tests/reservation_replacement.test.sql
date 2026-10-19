\set ON_ERROR_STOP 1
begin;
do $$begin assert current_date<date '2099-01-01','Revise fixed synthetic dates explicitly';end$$;
\ir fixtures/reservation_replacement.sql
create function pg_temp.rr_fail(p_plan jsonb,p_pattern text,p_expected jsonb default null) returns void language plpgsql as $$
declare s uuid:=(select id from tests.rr_context where k='sale'); snap jsonb;
begin
 begin
  snap:=coalesce(p_expected,public.preview_customer_order_reservation_replacement(s)->'snapshot');
  perform public.replace_customer_order_reservations(s,'ee900000-0000-4000-8000-000000000001',snap,p_plan,'Synthetic reason');
 exception when others then assert sqlerrm~p_pattern,sqlerrm;return;end;
 raise exception 'Expected rejection: %',p_pattern;
end $$;
create temp table rr_before as select id,quantity_on_hand,quantity_reserved from public.inventory_balances;
create temp table rr_sale_before as select * from public.sales where id=(select id from tests.rr_context where k='sale');
create temp table rr_snapshot(snap jsonb);
grant all on rr_snapshot to authenticated;
set local role authenticated;
insert into rr_snapshot select public.preview_customer_order_reservation_replacement(id)->'snapshot' from tests.rr_context where k='sale';
select pg_temp.rr_fail(jsonb_set(tests.rr_plan(),'{0,sale_quantity}','0.5'),'полностью');
select pg_temp.rr_fail(jsonb_build_array(jsonb_build_object('item_id',(select id from tests.rr_context where k='item'),'balance_id','ee500000-0000-4000-8000-000000000002','sale_quantity',2)),'Недостаточный');
select pg_temp.rr_fail(jsonb_build_array(jsonb_build_object('item_id',(select id from tests.rr_context where k='item'),'balance_id','ee500000-0000-4000-8000-000000000004','sale_quantity',2)),'письма');
select pg_temp.rr_fail(jsonb_set(tests.rr_plan(),'{0,sale_quantity}','1.0001'),'точностью');
select pg_temp.rr_fail(tests.rr_plan()||tests.rr_plan(),'несколько раз');
select pg_temp.rr_fail(tests.rr_plan('other-item'),'не относится');
reset role;

-- Every personal deny gates both read preview and direct write, before data is returned.
do $$declare permission_code text; s uuid:=(select id from tests.rr_context where k='sale');begin
 foreach permission_code in array array['sales.view','sales.manage','sales.reserve','sales.override_fefo','inventory.view','products.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'ee000000-0000-4000-8000-000000000001',p.id,'deny','Synthetic','ee000000-0000-4000-8000-000000000001' from public.permissions p where p.code=permission_code;
  begin perform public.preview_customer_order_reservation_replacement(s);raise exception 'Denied preview accepted';exception when insufficient_privilege then null;end;
  begin perform public.replace_customer_order_reservations(s,gen_random_uuid(),'{}',tests.rr_plan(),'Synthetic');raise exception 'Denied write accepted';exception when insufficient_privilege then null;end;
  delete from public.user_permission_overrides where user_id='ee000000-0000-4000-8000-000000000001';
 end loop;
 assert not has_function_privilege('service_role','public.replace_customer_order_reservations(uuid,uuid,jsonb,jsonb,text)','execute');
 assert not has_table_privilege('authenticated','public.sale_reservation_replacements','insert');
end$$;

savepoint stale;
update public.inventory_balances set quantity_on_hand=11 where id='ee500000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.rr_fail(tests.rr_plan(),'Остаток или состояние',(select snap from rr_snapshot));
rollback to stale;

savepoint blocked_new;
update public.inventory_batches set status='quarantine' where id='ee400000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.rr_fail(tests.rr_plan(),'карантине');
rollback to blocked_new;
savepoint missing_packaging;
delete from public.product_packaging where product_id='ee300000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.rr_fail(tests.rr_plan(),'Упаковка');
rollback to missing_packaging;
savepoint stale_packaging;
update public.product_packaging set units_per_parent=5 where product_id='ee300000-0000-4000-8000-000000000001' and uom='box';
set local role authenticated;
select pg_temp.rr_fail(tests.rr_plan(),'Упаковка товара',(select snap from rr_snapshot));
rollback to stale_packaging;
savepoint other_warehouse;
insert into public.warehouses(id,code,name,city,country) values ('ee200000-0000-4000-8000-000000000002','RR-OTHER','{"ru":"Другой"}','Synthetic','KZ');
update public.inventory_balances set warehouse_id='ee200000-0000-4000-8000-000000000002' where id='ee500000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.rr_fail(tests.rr_plan(),'складу');
rollback to other_warehouse;

-- Fail after releases and an insertion, not only at input validation: the entire transaction rolls back.
savepoint interrupted;
create function pg_temp.rr_interrupt() returns trigger language plpgsql as $$begin
 if new.inventory_balance_id='ee500000-0000-4000-8000-000000000003' then raise exception 'SYNTHETIC_INSERT_FAILURE';end if;return new;end$$;
create trigger rr_interrupt before insert on public.inventory_reservations for each row execute function pg_temp.rr_interrupt();
set local role authenticated;
select pg_temp.rr_fail(tests.rr_plan(),'SYNTHETIC_INSERT_FAILURE');
reset role;
do $$begin
 assert not exists(select 1 from public.inventory_balances b join rr_before old using(id) where b.quantity_on_hand<>old.quantity_on_hand or b.quantity_reserved<>old.quantity_reserved);
 assert not exists(select 1 from public.sale_reservation_replacements);
 assert (select count(*)=2 from public.inventory_reservations where status='active');
end$$;
rollback to interrupted;

-- Replace just one of two lines of the same product (different order UOM). The second line's
-- reservation ID, units and quantity remain unchanged; prices and physical stock remain unchanged.
savepoint partial_order;
set local role authenticated;
select public.return_customer_order_to_preparation(id,'Synthetic add untouched line') from tests.rr_context where k='sale';
reset role;
-- Fixture-only setup of an additional line; recovery deliberately does not allow editing confirmed quantities.
update public.sales set status='draft' where id=(select id from tests.rr_context where k='sale');
set local role authenticated;
insert into tests.rr_context select 'untouched',public.add_customer_order_item(id,'ee300000-0000-4000-8000-000000000001',1,'piece',7,60) from tests.rr_context where k='sale';
-- Setup a third eligible balance for the untouched line, via SQL fixture data only.
reset role;
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ee500000-0000-4000-8000-000000000005','ee400000-0000-4000-8000-000000000003','ee200000-0000-4000-8000-000000000001','box',10);
set local role authenticated;
select public.reserve_customer_order_item_override(id,'ee500000-0000-4000-8000-000000000005','Synthetic untouched') from tests.rr_context where k='untouched';
select public.set_inventory_batch_status('ee400000-0000-4000-8000-000000000001','available',null);
select public.confirm_customer_order(id) from tests.rr_context where k='sale';
select public.set_inventory_batch_status('ee400000-0000-4000-8000-000000000001','blocked','Synthetic');
reset role;
create temp table rr_untouched as select * from public.inventory_reservations where sale_item_id=(select id from tests.rr_context where k='untouched');
set local role authenticated;
select public.replace_customer_order_reservations(id,'ee900000-0000-4000-8000-000000000002',public.preview_customer_order_reservation_replacement(id)->'snapshot',tests.rr_plan(),'Synthetic partial') from tests.rr_context where k='sale';
reset role;
do $$begin
 assert (select count(*)=1 from public.inventory_reservations r join rr_untouched old using(id) where r.status=old.status and r.quantity=old.quantity and r.sale_quantity=old.sale_quantity and r.inventory_balance_id=old.inventory_balance_id);
 assert (select unit_price=7 from public.sale_items where id=(select id from tests.rr_context where k='untouched'));
end$$;
rollback to partial_order;

-- A real previously approved guarantee for the old batch must not cover the new low-OSG batch.
savepoint letter_binding;
update public.inventory_batches set expiry_date='2099-03-06',manufacture_date='2098-04-01',status='available' where id='ee400000-0000-4000-8000-000000000001';
set local role authenticated;
select public.return_customer_order_to_preparation(id,'Synthetic low-OSG setup') from tests.rr_context where k='sale';
insert into tests.rr_context select 'letter',public.create_sale_guarantee_letter(id,'Synthetic old batch letter') from tests.rr_context where k='sale';
select public.change_sale_guarantee_status(id,'approved') from tests.rr_context where k='letter';
select public.confirm_customer_order(id) from tests.rr_context where k='sale';
select public.set_inventory_batch_status('ee400000-0000-4000-8000-000000000001','blocked','Synthetic old batch');
select pg_temp.rr_fail(jsonb_build_array(jsonb_build_object('item_id',(select id from tests.rr_context where k='item'),'balance_id','ee500000-0000-4000-8000-000000000004','sale_quantity',2)),'письма');
-- Eligible high-OSG replacements do not mutate/cancel the original letter or its item history.
select public.replace_customer_order_reservations(id,'ee900000-0000-4000-8000-000000000003',public.preview_customer_order_reservation_replacement(id)->'snapshot',tests.rr_plan(),'Synthetic no transfer') from tests.rr_context where k='sale';
reset role;
do $$begin
 assert (select status='approved' from public.guarantee_letters where id=(select id from tests.rr_context where k='letter'));
 assert (select count(*)=1 and bool_and(batch_id='ee400000-0000-4000-8000-000000000001') from public.guarantee_letter_items where guarantee_letter_id=(select id from tests.rr_context where k='letter'));
end$$;
rollback to letter_binding;

set local role authenticated;
select public.preview_customer_order_reservation_replacement(id,tests.rr_plan()) from tests.rr_context where k='sale';
select public.replace_customer_order_reservations(id,'ee900000-0000-4000-8000-000000000001',(select snap from rr_snapshot),tests.rr_plan(),'Synthetic reason') from tests.rr_context where k='sale';
select public.replace_customer_order_reservations(id,'ee900000-0000-4000-8000-000000000001',(select snap from rr_snapshot),tests.rr_plan(),'Synthetic reason') from tests.rr_context where k='sale';
select pg_temp.rr_fail(tests.rr_plan(),'Идентификатор запроса','{}');
reset role;
do $$begin
 assert (select count(*)=1 from public.sale_reservation_replacements),'one immutable event';
 assert not exists(select 1 from public.inventory_balances b join rr_before old using(id) where b.quantity_on_hand<>old.quantity_on_hand),'no physical stock changes';
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.rr_context where k='sale'));
 assert (select s.status='confirmed' and s.confirmed_at=old.confirmed_at and s.confirmed_by=old.confirmed_by from public.sales s join rr_sale_before old using(id));
 assert (select count(*)=2 and sum(quantity)=20 and sum(sale_quantity)=2 from public.inventory_reservations where sale_item_id=(select id from tests.rr_context where k='item') and status='active');
 assert (select count(*)=1 and sum(quantity)=20 from public.inventory_reservations where sale_item_id=(select id from tests.rr_context where k='other-item') and status='active');
 assert (select jsonb_array_length(previous_allocation)=1 and jsonb_array_length(new_allocation)=2 and created_by='ee000000-0000-4000-8000-000000000001' and created_at is not null from public.sale_reservation_replacements);
end$$;
set local role authenticated;
select public.fulfill_customer_order(id) from tests.rr_context where k='sale';
-- Original lost-response replay is safe even after fulfillment.
select public.replace_customer_order_reservations(id,'ee900000-0000-4000-8000-000000000001',(select snap from rr_snapshot),tests.rr_plan(),'Synthetic reason') from tests.rr_context where k='sale';
reset role;
do $$begin
 assert (select count(*)=2 and sum(quantity)=20 from public.inventory_movements where sale_id=(select id from tests.rr_context where k='sale'));
 assert (select count(*)=1 from public.sale_reservation_replacements);
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=(select id from tests.rr_context where k='item') and status='fulfilled');
end$$;
rollback;
\echo reservation replacement: preview, exact units, split, rollback, permissions, replay, history and fulfillment passed
