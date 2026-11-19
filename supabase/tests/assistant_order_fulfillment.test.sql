\set ON_ERROR_STOP 1
begin;
\ir fixtures/order_fulfillment.sql
create temp table ao_order(review jsonb);
grant all on ao_order to authenticated;
insert into ao_order values(null);
set local role authenticated;
select public.prepare_assistant_operation('ee000000-0000-4000-8000-000000000001','customer_order_fulfillment',jsonb_build_object('sale_id',id)) from tests.fulfillment_context where k='sale';
update ao_order set review=public.review_assistant_operation('ee000000-0000-4000-8000-000000000001');
reset role;
do $$begin
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001'),'preview is read-only';
 assert (select status='confirmed' from public.sales where id=(select id from tests.fulfillment_context where k='sale'));
 assert (select jsonb_array_length(review#>'{preview,lines}')=2 from ao_order);
 assert (select review#>>'{preview,customer}'='Synthetic Buyer' from ao_order);
 assert (select review::text !~ 'state_stamp|unit_price|status_reason|Synthetic approval|Synthetic order' from ao_order),'safe projection';
 assert not has_function_privilege('authenticated','private.confirm_assistant_transfer(uuid,uuid)','execute');
 assert not has_function_privilege('service_role','public.confirm_assistant_operation(uuid,uuid)','execute');
end $$;
create function pg_temp.ao_order_fails(pattern text) returns void language plpgsql as $$begin
 begin
  perform public.confirm_assistant_operation('ee000000-0000-4000-8000-000000000001',(select (review->>'review_token')::uuid from ao_order));
 exception when others then assert sqlerrm ~ pattern,sqlerrm;return;end;
 raise exception 'Expected assistant refusal';
end $$;

-- Every operation permission, including preview-only data permissions, honors personal denial.
do $$declare permission text;begin
 foreach permission in array array['agent.use','sales.view','sales.manage','inventory.move','inventory.view','products.view','warehouses.view','customers.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'ef000000-0000-4000-8000-000000000001',id,'deny','Synthetic deny','ef000000-0000-4000-8000-000000000001' from public.permissions where code=permission;
  perform pg_temp.ao_order_fails('ASSISTANT_OPERATION_DENIED');
  begin perform public.review_assistant_operation('ee000000-0000-4000-8000-000000000001');raise exception 'Denied preview leaked';
  exception when insufficient_privilege then null;end;
  delete from public.user_permission_overrides where user_id='ef000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
savepoint other_actor;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000099',true);
set local role authenticated;
select pg_temp.ao_order_fails('ASSISTANT_OPERATION_DENIED');
rollback to other_actor;
savepoint changed;
update public.sales set notes='Changed after review' where id=(select id from tests.fulfillment_context where k='sale');
set local role authenticated;
select pg_temp.ao_order_fails('ASSISTANT_OPERATION_STALE');
rollback to changed;
savepoint blocked;
update public.inventory_batches set status='blocked' where id='ef400000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ao_order_fails('ASSISTANT_OPERATION_ORDER_BLOCKED');
rollback to blocked;
savepoint letter;
set local role authenticated;
select public.change_sale_guarantee_status(id,'cancelled') from tests.fulfillment_context where k='letter';
select pg_temp.ao_order_fails('ASSISTANT_OPERATION_ORDER_BLOCKED');
rollback to letter;
savepoint cancelled;
set local role authenticated;
select public.cancel_customer_order(id,'Synthetic cancellation after preview') from tests.fulfillment_context where k='sale';
select pg_temp.ao_order_fails('ASSISTANT_OPERATION_ORDER_STATE');
rollback to cancelled;
savepoint injected;
create function pg_temp.ao_order_interrupt() returns trigger language plpgsql as $$begin
 if new.sale_id is not null and exists(select 1 from public.inventory_movements where sale_id=new.sale_id) then raise exception 'SYNTHETIC_SECOND_ISSUE_FAILURE';end if;
 return new;end $$;
create trigger ao_order_interrupt before insert on public.inventory_movements for each row execute function pg_temp.ao_order_interrupt();
set local role authenticated;
select pg_temp.ao_order_fails('SYNTHETIC_SECOND_ISSUE_FAILURE');
reset role;
do $$begin
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale'));
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001');
 assert (select result_sale_id is null from private.assistant_operations where id='ee000000-0000-4000-8000-000000000001'),'receipt rolls back too';
end $$;
rollback to injected;
set local role authenticated;
select public.confirm_assistant_operation('ee000000-0000-4000-8000-000000000001',(review->>'review_token')::uuid) from ao_order;
select public.confirm_assistant_operation('ee000000-0000-4000-8000-000000000001',(review->>'review_token')::uuid) from ao_order;
update ao_order set review=public.review_assistant_operation('ee000000-0000-4000-8000-000000000001');
reset role;
do $$begin
 assert (select review->>'status'='completed' and review->>'kind'='customer_order_fulfillment' from ao_order);
 assert (select sum(quantity_on_hand)=150 and sum(quantity_reserved)=50 from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001');
 assert (select count(*)=2 and sum(quantity)=150 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='sale')),'replay does not issue twice';
 assert (select count(*)=2 from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='item') and status='fulfilled');
 assert (select quantity=50 and status='active' from public.inventory_reservations where sale_item_id=(select id from tests.fulfillment_context where k='other-item'));
end $$;
-- Boxes are kept in the order, pieces in the stock: existing reserve/fulfill conversion, no new calculation.
insert into public.product_packaging(product_id,uom,units_per_parent) values('ef300000-0000-4000-8000-000000000001','box',12);
set local role authenticated;
insert into tests.fulfillment_context values('box-sale',public.create_customer_order('ef100000-0000-4000-8000-000000000002',null,'ef200000-0000-4000-8000-000000000001','2099-01-20',null,'Synthetic box order'));
insert into tests.fulfillment_context select 'box-item',public.add_customer_order_item(id,'ef300000-0000-4000-8000-000000000001',2,'box',120,60,'Синтетическая цена') from tests.fulfillment_context where k='box-sale';
select public.reserve_customer_order_item_fefo(id) from tests.fulfillment_context where k='box-item';
select public.confirm_customer_order(id) from tests.fulfillment_context where k='box-sale';
select public.prepare_assistant_operation('ee000000-0000-4000-8000-000000000002','customer_order_fulfillment',jsonb_build_object('sale_id',id)) from tests.fulfillment_context where k='box-sale';
update ao_order set review=public.review_assistant_operation('ee000000-0000-4000-8000-000000000002');
do $$begin
 assert (select (review#>>'{preview,items,0,quantity}')::numeric=2 and review#>>'{preview,items,0,uom}'='box' from ao_order);
 assert (select (review#>>'{preview,lines,0,quantity}')::numeric=24 and review#>>'{preview,lines,0,uom}'='piece' from ao_order);
end $$;
select public.confirm_assistant_operation('ee000000-0000-4000-8000-000000000002',(review->>'review_token')::uuid) from ao_order;
reset role;
do $$begin
 assert (select sum(quantity)=24 from public.inventory_movements where sale_id=(select id from tests.fulfillment_context where k='box-sale'));
 assert (select sum(quantity_on_hand)=126 and sum(quantity_reserved)=50 from public.inventory_balances where warehouse_id='ef200000-0000-4000-8000-000000000001');
end $$;
rollback;
\echo assistant_order_fulfillment: projection, permissions, stale state, letters, rollback, replay and boxes passed
