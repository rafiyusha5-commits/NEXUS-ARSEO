\set ON_ERROR_STOP 1
begin;
\ir fixtures/assistant_reservation.sql
create temp table ar(review jsonb);
grant all on ar to authenticated;
set local role authenticated;
select public.prepare_assistant_operation('eb000000-8a23-4000-8000-000000000051','customer_order_reserve',jsonb_build_object('sale_id',id)) from tests.assistant_reserve_context where k='sale';
insert into ar select public.review_assistant_operation('eb000000-8a23-4000-8000-000000000051');
do $$begin
 assert (select (review#>>'{preview,low_shelf_life}')::boolean from ar),'low OSG is an explicit warning, not silent rejection/substitution';
 assert (select jsonb_array_length(review#>'{preview,lines}') between 3 and 4 from ar),'two units share stock with exact packaging and no double allocation';
 assert not exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=(select id from tests.assistant_reserve_context where k='sale')),'preview writes no reserve';
 assert (select review::text !~ 'state_stamp|letters_stamp|unit_price|notes' from ar),'safe projection';
end $$;
reset role;
create function pg_temp.ar_fail(expected text) returns void language plpgsql as $$begin
 begin perform public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000051',(select (review->>'review_token')::uuid from ar));
 exception when others then assert sqlerrm like expected,sqlerrm;return;end;
 raise exception 'Expected refusal';
end $$;
savepoint deny;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'eb000000-8a23-4000-8000-000000000001',id,'deny','Synthetic deny','eb000000-8a23-4000-8000-000000000001' from public.permissions where code='sales.reserve';
set local role authenticated;
select pg_temp.ar_fail('ASSISTANT_OPERATION_DENIED');
rollback to deny;
do $$declare permission text;begin
 foreach permission in array array['agent.use','sales.view','sales.manage','inventory.view','customers.view','products.view','warehouses.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'eb000000-8a23-4000-8000-000000000001',id,'deny','Synthetic deny','eb000000-8a23-4000-8000-000000000001' from public.permissions where code=permission;
  perform pg_temp.ar_fail('ASSISTANT_OPERATION_DENIED');
  begin perform public.review_assistant_operation('eb000000-8a23-4000-8000-000000000051');raise exception 'Denied review';
  exception when insufficient_privilege then null;end;
  delete from public.user_permission_overrides where user_id='eb000000-8a23-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
savepoint blocked;
update public.inventory_batches set status='blocked' where id='eb400000-8a23-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ar_fail('ASSISTANT_OPERATION_STALE');
rollback to blocked;
savepoint quarantine;
update public.inventory_batches set status='quarantine' where product_id='eb300000-8a23-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ar_fail('ASSISTANT_OPERATION_RESERVE_BLOCKED');
rollback to quarantine;
savepoint expired;
update public.inventory_batches set expiry_date='2099-01-19' where product_id='eb300000-8a23-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ar_fail('ASSISTANT_OPERATION_RESERVE_BLOCKED');
rollback to expired;
savepoint shortage;
update public.inventory_balances set quantity_on_hand=0 where warehouse_id='eb200000-8a23-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ar_fail('ASSISTANT_OPERATION_RESERVE_BLOCKED');
rollback to shortage;
savepoint precision;
delete from public.product_packaging where product_id='eb300000-8a23-4000-8000-000000000001';
set local role authenticated;
select pg_temp.ar_fail('ASSISTANT_OPERATION_RESERVE_BLOCKED');
rollback to precision;
savepoint injected;
create function pg_temp.ar_interrupt() returns trigger language plpgsql as $$begin
 if new.sale_item_id=(select id from public.sale_items where sale_id=(select id from tests.assistant_reserve_context where k='sale') order by id desc limit 1) then raise exception 'SYNTHETIC_RESERVE_FAILURE';end if;return new;
end $$;
create trigger ar_interrupt before insert on public.inventory_reservations for each row execute function pg_temp.ar_interrupt();
set local role authenticated;
select pg_temp.ar_fail('SYNTHETIC_RESERVE_FAILURE');
reset role;
do $$begin
 assert (select sum(quantity_reserved)=0 from public.inventory_balances where warehouse_id='eb200000-8a23-4000-8000-000000000001'),'all lines roll back';
 assert (select result_sale_id is null from private.assistant_operations where id='eb000000-8a23-4000-8000-000000000051');
end $$;
rollback to injected;
set local role authenticated;
select public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000051',(review->>'review_token')::uuid) from ar;
select public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000051',(review->>'review_token')::uuid) from ar;
do $$begin
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='eb200000-8a23-4000-8000-000000000001');
 assert (select status='reserved' and confirmed_at is null and shipped_at is null from public.sales where id=(select id from tests.assistant_reserve_context where k='sale'));
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.assistant_reserve_context where k='sale'));
 begin perform public.confirm_customer_order((select id from tests.assistant_reserve_context where k='sale'));raise exception 'Unexpected confirmation';
 exception when others then assert sqlerrm like '%гарантийное письмо%',sqlerrm;end;
 begin perform public.fulfill_customer_order((select id from tests.assistant_reserve_context where k='sale'));raise exception 'Unexpected issue';
 exception when others then assert sqlerrm like '%подтверждённый%',sqlerrm;end;
end $$;
-- Normal guarantee workflow remains the only way to confirm the low-OSG order.
insert into tests.assistant_reserve_context select 'letter',public.create_sale_guarantee_letter(id,'Synthetic explicit approval') from tests.assistant_reserve_context where k='sale';
select public.change_sale_guarantee_status(id,'approved') from tests.assistant_reserve_context where k='letter';
select public.confirm_customer_order(id) from tests.assistant_reserve_context where k='sale';
select public.fulfill_customer_order(id) from tests.assistant_reserve_context where k='sale';
reset role;
do $$begin
 assert (select sum(quantity_on_hand)=100 and sum(quantity_reserved)=0 from public.inventory_balances where warehouse_id='eb200000-8a23-4000-8000-000000000001');
 assert (select count(*)=(select jsonb_array_length(review#>'{preview,lines}') from ar) and sum(quantity)=200 from public.inventory_movements where sale_id=(select id from tests.assistant_reserve_context where k='sale'));
 assert not has_function_privilege('authenticated','private.plan_customer_order_item_fefo(uuid,jsonb)','execute');
 assert not has_function_privilege('service_role','public.confirm_assistant_operation(uuid,uuid)','execute');
end $$;
rollback;
