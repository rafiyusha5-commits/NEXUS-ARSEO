\set ON_ERROR_STOP 1
begin;
\ir fixtures/assistant_reservation.sql
set local role authenticated;
select public.reserve_customer_order_item_fefo(id) from public.sale_items where sale_id=(select id from tests.assistant_reserve_context where k='sale') order by id;
do $$begin
 begin
  perform public.prepare_assistant_operation('eb000000-8a23-4000-8000-000000000081','customer_order_confirm',
   jsonb_build_object('sale_id',(select id from tests.assistant_reserve_context where k='sale')));
  raise exception 'Expected letter refusal';
 exception when others then assert sqlerrm='ASSISTANT_OPERATION_CONFIRM_BLOCKED',sqlerrm;end;
end $$;
insert into tests.assistant_reserve_context select 'letter',public.create_sale_guarantee_letter(id,'Synthetic approval, no assistant waiver') from tests.assistant_reserve_context where k='sale';
select public.change_sale_guarantee_status(id,'approved') from tests.assistant_reserve_context where k='letter';
reset role;
create temp table confirmation_before as select
 (select jsonb_agg(to_jsonb(r) order by r.id) from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=(select id from tests.assistant_reserve_context where k='sale')) reservations,
 (select jsonb_agg(to_jsonb(b) order by b.id) from public.inventory_balances b where warehouse_id='eb200000-8a23-4000-8000-000000000001') balances,
 (select jsonb_agg(to_jsonb(g) order by g.id) from public.guarantee_letters g where sale_id=(select id from tests.assistant_reserve_context where k='sale')) letters;
create temp table cr(review jsonb);
grant all on cr to authenticated;
set local role authenticated;
select public.prepare_assistant_operation('eb000000-8a23-4000-8000-000000000081','customer_order_confirm',jsonb_build_object('sale_id',id)) from tests.assistant_reserve_context where k='sale';
insert into cr select public.review_assistant_operation('eb000000-8a23-4000-8000-000000000081');
reset role;
do $$begin
 assert (select status='reserved' and confirmed_at is null from public.sales where id=(select id from tests.assistant_reserve_context where k='sale'));
 assert (select reservations=(select jsonb_agg(to_jsonb(r) order by r.id) from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=(select id from tests.assistant_reserve_context where k='sale')) from confirmation_before),'preview has no OSG refresh writes';
 assert (select review::text !~ 'state_stamp|unit_price|notes|Synthetic approval' from cr),'no private data';
end $$;
create function pg_temp.cf_fail(expected text) returns void language plpgsql as $$begin
 begin perform public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000081',(select (review->>'review_token')::uuid from cr));
 exception when others then assert sqlerrm=expected,sqlerrm;return;end;
 raise exception 'Expected refusal';
end $$;
do $$declare permission text;begin
 foreach permission in array array['agent.use','sales.view','sales.manage','inventory.view','customers.view','products.view','warehouses.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'eb000000-8a23-4000-8000-000000000001',id,'deny','Synthetic deny','eb000000-8a23-4000-8000-000000000001' from public.permissions where code=permission;
  perform pg_temp.cf_fail('ASSISTANT_OPERATION_DENIED');
  begin perform public.review_assistant_operation('eb000000-8a23-4000-8000-000000000081');raise exception 'Denied review';
  exception when insufficient_privilege then null;end;
  delete from public.user_permission_overrides where user_id='eb000000-8a23-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
savepoint stranger;
select set_config('request.jwt.claim.sub','eb000000-8a23-4000-8000-000000000099',true);
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_DENIED');
rollback to stranger;
savepoint changed;
update public.sales set planned_shipment_date='2099-01-21' where id=(select id from tests.assistant_reserve_context where k='sale');
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_CONFIRM_BLOCKED');
rollback to changed;
savepoint letter;
update public.guarantee_letters set status='cancelled' where id=(select id from tests.assistant_reserve_context where k='letter');
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_CONFIRM_BLOCKED');
rollback to letter;
savepoint wrong_letter;
update public.guarantee_letter_items set quantity=quantity+1 where guarantee_letter_id=(select id from tests.assistant_reserve_context where k='letter');
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_CONFIRM_BLOCKED');
rollback to wrong_letter;
savepoint batch;
update public.inventory_batches set status='blocked' where id='eb400000-8a23-4000-8000-000000000001';
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_CONFIRM_BLOCKED');
rollback to batch;
savepoint incomplete;
update public.sale_items set quantity=quantity+1 where id=(select id from tests.assistant_reserve_context where k='item');
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_CONFIRM_BLOCKED');
rollback to incomplete;
savepoint stale;
update public.sales set notes='Changed synthetic note' where id=(select id from tests.assistant_reserve_context where k='sale');
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_STALE');
rollback to stale;
-- Real receivables guard, no synthetic trigger: lower credit limit after review.
savepoint credit;
update public.sale_items set unit_price=100 where sale_id=(select id from tests.assistant_reserve_context where k='sale');
set local role authenticated;
select public.prepare_assistant_operation('eb000000-8a23-4000-8000-000000000082','customer_order_confirm',jsonb_build_object('sale_id',id)) from tests.assistant_reserve_context where k='sale';
reset role;
insert into public.customer_credit_terms(customer_id,credit_limit,limit_currency_id)
 values('eb100000-8a23-4000-8000-000000000002',0,private.currency_by_code('KZT'));
do $$begin
 assert jsonb_array_length(private.sale_credit_issues((select id from tests.assistant_reserve_context where k='sale')))>0,'actual financial risk';
end $$;
set local role authenticated;
do $$begin
 begin
  perform public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000082',(public.review_assistant_operation('eb000000-8a23-4000-8000-000000000082')->>'review_token')::uuid);
  raise exception 'Credit guard bypass';
 exception when others then assert sqlerrm='ASSISTANT_OPERATION_CONFIRM_REFUSED',sqlerrm;end;
end $$;
rollback to credit;
-- A financial refusal at the existing trigger must roll back refreshed OSG and never leak amounts.
savepoint finance;
create function pg_temp.cf_finance() returns trigger language plpgsql as $$begin
 if new.status='confirmed' then raise exception 'SQL financial secret 987654321';end if;return new;
end $$;
create trigger cf_finance before update on public.sales for each row execute function pg_temp.cf_finance();
set local role authenticated;
select pg_temp.cf_fail('ASSISTANT_OPERATION_CONFIRM_REFUSED');
reset role;
do $$begin
 assert (select status='reserved' and confirmed_at is null from public.sales where id=(select id from tests.assistant_reserve_context where k='sale'));
 assert (select result_sale_id is null from private.assistant_operations where id='eb000000-8a23-4000-8000-000000000081');
end $$;
rollback to finance;
-- Confirmation needs neither inventory.move nor sales.reserve; it grants neither.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'eb000000-8a23-4000-8000-000000000001',id,'deny','Synthetic least privilege','eb000000-8a23-4000-8000-000000000001' from public.permissions where code in ('inventory.move','sales.reserve');
set local role authenticated;
select public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000081',(review->>'review_token')::uuid) from cr;
select public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000081',(review->>'review_token')::uuid) from cr;
reset role;
do $$begin
 assert (select status='confirmed' and confirmed_by='eb000000-8a23-4000-8000-000000000001' and confirmed_at is not null and shipped_at is null from public.sales where id=(select id from tests.assistant_reserve_context where k='sale'));
 assert (select balances=(select jsonb_agg(to_jsonb(b) order by b.id) from public.inventory_balances b where warehouse_id='eb200000-8a23-4000-8000-000000000001') from confirmation_before);
 assert (select letters=(select jsonb_agg(to_jsonb(g) order by g.id) from public.guarantee_letters g where sale_id=(select id from tests.assistant_reserve_context where k='sale')) from confirmation_before);
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.assistant_reserve_context where k='sale'));
 assert not exists(select 1 from private.customer_ledger('eb100000-8a23-4000-8000-000000000002'));
 assert not has_function_privilege('authenticated','private.customer_order_allocation_blockers(uuid,date,boolean)','execute');
 assert not has_function_privilege('service_role','public.confirm_assistant_operation(uuid,uuid)','execute');
end $$;
delete from public.user_permission_overrides where user_id='eb000000-8a23-4000-8000-000000000001';
set local role authenticated;
select public.fulfill_customer_order(id) from tests.assistant_reserve_context where k='sale';
select public.confirm_assistant_operation('eb000000-8a23-4000-8000-000000000081',(review->>'review_token')::uuid) from cr;
reset role;
do $$begin
 assert (select status='shipped' from public.sales where id=(select id from tests.assistant_reserve_context where k='sale')),'retry does not revert shipped order';
 assert (select sum(quantity_on_hand)=100 and sum(quantity_reserved)=0 from public.inventory_balances where warehouse_id='eb200000-8a23-4000-8000-000000000001');
end $$;
rollback;
