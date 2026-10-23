\set ON_ERROR_STOP 1
begin;
set local timezone='UTC';
do $$begin assert current_date<date '2099-01-01','Explicitly revise fixed fixture dates';end$$;
\ir fixtures/order_fulfillment.sql
create function pg_temp.ff_fails(pattern text) returns void language plpgsql as $$begin
 begin
  perform public.fulfill_customer_order((select id from tests.fulfillment_context where k='sale'));
 exception when others then assert sqlerrm ~* pattern,sqlerrm;return;end;
 raise exception 'Expected fulfillment rejection';
end$$;
do $$begin
 assert not has_function_privilege('anon','public.fulfill_customer_order(uuid)','execute');
 assert not has_function_privilege('service_role','public.fulfill_customer_order(uuid)','execute');
 assert not has_table_privilege('authenticated','public.inventory_movements','insert');
 assert not has_table_privilege('authenticated','public.sales','update');
end$$;

-- Permission intersection and a personal deny, before any existence/idempotency response.
savepoint permission_check;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000001',id,'deny','Synthetic deny','ef000000-0000-4000-8000-000000000001' from public.permissions where code='inventory.move';
set local role authenticated;
select pg_temp.ff_fails('Недостаточно прав');
rollback to permission_check;
savepoint sales_permission;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000001',id,'deny','Synthetic deny','ef000000-0000-4000-8000-000000000001' from public.permissions where code='sales.manage';
set local role authenticated;
select pg_temp.ff_fails('Недостаточно прав');
rollback to sales_permission;

savepoint state_check;
update public.sales set status='draft' where id=(select id from tests.fulfillment_context where k='sale');
set local role authenticated;
select pg_temp.ff_fails('подтверждённый');
rollback to state_check;
savepoint missing_reservation;
update public.inventory_reservations set status='cancelled' where sale_item_id=(select id from tests.fulfillment_context where k='item') and batch_id='ef400000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ff_fails('полностью зарезервирован');
rollback to missing_reservation;
savepoint corrupt_balance;
update public.inventory_balances set quantity_reserved=99 where id='ef500000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ff_fails('не согласованы');
rollback to corrupt_balance;
savepoint wrong_uom;
update public.inventory_balances set uom='box' where id='ef500000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ff_fails('не соответствует');
rollback to wrong_uom;
savepoint wrong_batch;
update public.inventory_reservations set batch_id='ef400000-0000-4000-8000-000000000002'
where sale_item_id=(select id from tests.fulfillment_context where k='item') and batch_id='ef400000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ff_fails('не соответствует');
rollback to wrong_batch;
savepoint wrong_warehouse;
insert into public.warehouses(id,code,name,city,country) values ('ef200000-0000-4000-8000-000000000002','SYNTH-FF2','{"ru":"Другой вымышленный склад"}','Synthetic City','KZ');
update public.sales set warehouse_id='ef200000-0000-4000-8000-000000000002' where id=(select id from tests.fulfillment_context where k='sale');
set local role authenticated;
select pg_temp.ff_fails('не соответствует');
rollback to wrong_warehouse;
savepoint blocked;
update public.inventory_batches set status='blocked' where id='ef400000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.ff_fails('заблокирована');
rollback to blocked;
savepoint expired;
update public.inventory_batches set manufacture_date='2000-01-01',expiry_date='2001-01-01' where id='ef400000-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.ff_fails('просрочена');
rollback to expired;
savepoint revoked_letter;
set local role authenticated;
select public.change_sale_guarantee_status(id,'cancelled') from tests.fulfillment_context where k='letter';
select pg_temp.ff_fails('гарантийного письма');
rollback to revoked_letter;
savepoint stale_letter;
update public.sales set planned_shipment_date='2099-01-21' where id=(select id from tests.fulfillment_context where k='sale');
set local role authenticated;
select pg_temp.ff_fails('гарантийного письма');
rollback to stale_letter;

-- Inject an error after the first issue is inserted: every balance/reservation/ledger write rolls back.
savepoint injected_failure;
create function pg_temp.ff_interrupt() returns trigger language plpgsql as $$begin
 if new.sale_id is not null and exists(select 1 from public.inventory_movements where sale_id=new.sale_id) then
  raise exception 'SYNTHETIC_SECOND_MOVEMENT_FAILURE';
 end if;return new;end$$;
create trigger ff_interrupt before insert on public.inventory_movements for each row execute function pg_temp.ff_interrupt();
set local role authenticated;
select pg_temp.ff_fails('SYNTHETIC_SECOND_MOVEMENT_FAILURE');
reset role;
do $$begin
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001'),'full rollback';
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale'));
 assert (select status='confirmed' and shipped_at is null from public.sales where id=(select id from tests.fulfillment_context where k='sale'));
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='item') and status='active');
end$$;
rollback to injected_failure;

set local role authenticated;
select public.fulfill_customer_order(id) from tests.fulfillment_context where k='sale';
reset role;
create temp table ff_shipped_snapshot as select shipped_at,shipped_by from public.sales where id=(select id from tests.fulfillment_context where k='sale');
set local role authenticated;
select public.fulfill_customer_order(id) from tests.fulfillment_context where k='sale';
reset role;
do $$begin
 assert (select row(s.shipped_at,s.shipped_by)=row(f.shipped_at,f.shipped_by) from public.sales s cross join ff_shipped_snapshot f where s.id=(select id from tests.fulfillment_context where k='sale')),'replay preserves audit metadata';
 assert (select sum(quantity_on_hand)=150 and sum(quantity_reserved)=50 from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001');
 assert (select count(*)=2 and sum(quantity)=150 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale')),'exactly two issues on replay';
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='item') and status='fulfilled');
 assert (select status='shipped' and shipped_at is not null and shipped_by='ef000000-0000-4000-8000-000000000001' from public.sales where id=(select id from tests.fulfillment_context where k='sale'));
 assert (select status='depleted' from public.inventory_batches where id='ef400000-0000-4000-8000-000000000001');
 assert (select quantity=50 and status='active' from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='other-item')),'other order preserved';
 assert not exists(select 1 from public.inventory_movements m join public.inventory_reservations r on r.id=m.inventory_reservation_id where m.sale_id=(select id from tests.fulfillment_context where k='sale') and (m.quantity<>r.quantity or m.batch_id<>r.batch_id or m.sale_item_id<>r.sale_item_id or m.movement_type<>'issue'));
 begin
  insert into public.inventory_movements(batch_id,movement_type,quantity,uom,from_warehouse_id,inventory_reservation_id)
   select batch_id,'issue',quantity,uom,from_warehouse_id,inventory_reservation_id from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale') limit 1;
  raise exception 'Duplicate reservation movement accepted';
 exception when unique_violation then null;end;
end$$;
set local role authenticated;
do $$begin
 begin perform public.cancel_customer_order((select id from tests.fulfillment_context where k='sale'),'Synthetic');raise exception 'Shipped cancellation accepted';
 exception when others then assert sqlerrm like '%нельзя отменить%';end;
end$$;
reset role;
rollback;
\echo customer_order_fulfillment: atomicity, replay, permissions, integrity and shelf-life passed
