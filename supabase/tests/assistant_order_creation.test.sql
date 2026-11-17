\set ON_ERROR_STOP 1
begin;
\ir fixtures/assistant_order_creation.sql
create temp table draft_unchanged as select
 (select count(*) from public.inventory_movements) movements,(select count(*) from public.inventory_reservations) reservations,
 (select coalesce(sum(quantity_on_hand),0) from public.inventory_balances) stock;
set local role authenticated;
select public.prepare_assistant_operation('ad000000-8a22-4000-8000-000000000051','customer_order_create',payload) from tests.assistant_draft_context;
select public.prepare_assistant_operation('ad000000-8a22-4000-8000-000000000051','customer_order_create',payload) from tests.assistant_draft_context;
update tests.assistant_draft_context set review=public.review_assistant_operation('ad000000-8a22-4000-8000-000000000051');
do $$begin
 assert not exists(select 1 from public.sales where customer_id='ad000000-8a22-4000-8000-000000000011'),'no business draft before confirmation';
 assert (select review#>>'{preview,total}'='200.99' from tests.assistant_draft_context),'price list: box of 2 * 50 = 100.00 * 2 + 0.33 * 3 = 200.99';
 assert (select review#>>'{preview,items,0,unit_price}'='100.00' and review#>>'{preview,items,0,price_source}'='price_list'
   and review#>>'{preview,items,0,price_note}'='brand_condition_missing' from tests.assistant_draft_context),'the review shows where the price came from';
 assert (select jsonb_array_length(review#>'{preview,items}')=2 from tests.assistant_draft_context);
 assert (select review::text !~ 'PRIVATE-SYNTHETIC|state_stamp|registration_number|tax_id' from tests.assistant_draft_context);
 assert not has_function_privilege('service_role','public.confirm_assistant_operation(uuid,uuid)','execute');
 assert not has_function_privilege('authenticated','private.confirm_assistant_stock_operation(uuid,uuid)','execute');
end $$;
reset role;
create function pg_temp.draft_fails(pattern text) returns void language plpgsql as $$begin
 begin
  perform public.confirm_assistant_operation('ad000000-8a22-4000-8000-000000000051',(select (review->>'review_token')::uuid from tests.assistant_draft_context));
 exception when others then assert sqlerrm ~ pattern,sqlerrm;return;end;
 raise exception 'Expected draft refusal';
end $$;
do $$declare permission text;begin
 foreach permission in array array['agent.use','sales.view','sales.manage','customers.view','products.view','warehouses.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'ad000000-8a22-4000-8000-000000000001',id,'deny','Synthetic draft deny','ad000000-8a22-4000-8000-000000000001' from public.permissions where code=permission;
  perform pg_temp.draft_fails('ASSISTANT_OPERATION_DENIED');
  begin perform public.review_assistant_operation('ad000000-8a22-4000-8000-000000000051');raise exception 'Denied preview leaked';
  exception when insufficient_privilege then null;end;
  delete from public.user_permission_overrides where user_id='ad000000-8a22-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
savepoint other_actor;
set local role authenticated;
select set_config('request.jwt.claim.sub','ad000000-8a22-4000-8000-000000000002',true);
select pg_temp.draft_fails('ASSISTANT_OPERATION_DENIED');
rollback to other_actor;
savepoint changed;
update public.counterparties set min_remaining_shelf_life_pct=80 where id='ad000000-8a22-4000-8000-000000000011';
set local role authenticated;
select pg_temp.draft_fails('ASSISTANT_OPERATION_STALE');
rollback to changed;
savepoint price_changed;
insert into public.price_list_entries(price_type_id,product_id,price,valid_from,origin,reason,created_by)
 select id,'ad000000-8a22-4000-8000-000000000022',0.5,private.business_today(),'manual','Новая цена','ad000000-8a22-4000-8000-000000000001'
 from public.price_types where code='kz_prepayment';
set local role authenticated;
select pg_temp.draft_fails('ASSISTANT_OPERATION_STALE');
rollback to price_changed;
savepoint contract_closed;
update public.contracts set status='terminated' where id='ad000000-8a22-4000-8000-000000000041';
set local role authenticated;
select pg_temp.draft_fails('ASSISTANT_OPERATION_DRAFT_SOURCE');
rollback to contract_closed;
savepoint product_archived;
update public.products set status='archived' where id='ad000000-8a22-4000-8000-000000000022';
set local role authenticated;
select pg_temp.draft_fails('ASSISTANT_OPERATION_DRAFT_SOURCE');
rollback to product_archived;
-- Validate direct RPC input, not just the browser parser.
set local role authenticated;
do $$declare payload jsonb; patch jsonb;begin
 select c.payload into payload from tests.assistant_draft_context c;
 for patch in select value from jsonb_array_elements(jsonb_build_array(
  jsonb_set(payload,'{items,0,unit_price}','null'),jsonb_set(payload,'{items,0,quantity}','"0"'),
  jsonb_set(payload,'{items,0,uom}','"kg"'),jsonb_set(payload,'{items,0,unit_price}','"1e3"'),
  jsonb_set(payload,'{items,0,quantity}','"0.0001"'),jsonb_set(payload,'{planned_shipment_date}','"2020-01-01"'),
  jsonb_set(payload,'{items}',jsonb_build_array(payload#>'{items,0}',payload#>'{items,0}')),
  jsonb_set(payload,'{items,0,unit_price}','"100.1250"'),
  payload-'contract_id',payload||'{"confirm":true}'::jsonb)) loop
  begin perform public.prepare_assistant_operation(gen_random_uuid(),'customer_order_create',patch);raise exception 'Bad input accepted';
  exception when others then assert sqlerrm='ASSISTANT_OPERATION_DRAFT_INVALID',sqlerrm;end;
 end loop;
 begin perform public.prepare_assistant_operation('ad000000-8a22-4000-8000-000000000051','customer_order_create',jsonb_set(payload,'{items,0,unit_price}','"5"'));
  raise exception 'Changed request accepted';exception when others then assert sqlerrm='ASSISTANT_OPERATION_DENIED';end;
end $$;
reset role;
savepoint injected;
create function pg_temp.draft_interrupt() returns trigger language plpgsql as $$begin
 if new.product_id='ad000000-8a22-4000-8000-000000000022' then raise exception 'SYNTHETIC_SECOND_ITEM_FAILURE';end if;return new;
end $$;
create trigger draft_interrupt before insert on public.sale_items for each row execute function pg_temp.draft_interrupt();
set local role authenticated;
select pg_temp.draft_fails('SYNTHETIC_SECOND_ITEM_FAILURE');
reset role;
do $$begin
 assert not exists(select 1 from public.sales where customer_id='ad000000-8a22-4000-8000-000000000011'),'header also rolled back';
 assert (select result_sale_id is null from private.assistant_operations where id='ad000000-8a22-4000-8000-000000000051');
end $$;
rollback to injected;
-- Creating a draft needs no stock operation permission and must not use such operations.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ad000000-8a22-4000-8000-000000000001',id,'deny','Synthetic no stock writes','ad000000-8a22-4000-8000-000000000001' from public.permissions where code in ('inventory.move','sales.reserve');
set local role authenticated;
update tests.assistant_draft_context set result=public.confirm_assistant_operation('ad000000-8a22-4000-8000-000000000051',(review->>'review_token')::uuid);
select public.confirm_assistant_operation('ad000000-8a22-4000-8000-000000000051',(review->>'review_token')::uuid) from tests.assistant_draft_context;
reset role;
do $$declare sale uuid;begin
 select (result->>'result_id')::uuid into sale from tests.assistant_draft_context;
 assert (select count(*)=1 from public.sales where customer_id='ad000000-8a22-4000-8000-000000000011');
 assert (select status='draft' and confirmed_at is null and shipped_at is null and created_by='ad000000-8a22-4000-8000-000000000001' from public.sales where id=sale);
 assert (select count(*)=2 and bool_and(required_shelf_life_pct=70) from public.sale_items where sale_id=sale);
 assert (select amount=200.99 and unpriced_lines=0 from private.sale_amount(sale));
 assert (select bool_and(price_source='price_list' and price_snapshot->>'price_type'='kz_prepayment') from public.sale_items where sale_id=sale),'lines keep the price-list snapshot';
 assert (select movements=(select count(*) from public.inventory_movements) and reservations=(select count(*) from public.inventory_reservations)
  and stock=(select coalesce(sum(quantity_on_hand),0) from public.inventory_balances) from draft_unchanged),'no stock side effects';
 assert not exists(select 1 from private.customer_ledger('ad000000-8a22-4000-8000-000000000011')),'no new debt/payment';
end $$;
rollback;
\echo assistant_order_creation: atomic draft, price-list prices, permissions, stale sources, no stock/finance and replay passed
