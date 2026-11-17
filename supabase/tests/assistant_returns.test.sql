-- Returns from customers (202609277500): only against a shipped order, never more than shipped per line and batch,
-- quarantine outside the sellable stock, decisions with the right permissions, cancellation.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ac250000-0000-4000-8000-000000000001','assistant-returns-director@test.local','{"full_name":"Returns Director"}'),
 ('ac250000-0000-4000-8000-000000000002','assistant-returns-viewer@test.local','{"full_name":"Returns Viewer"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ac250000-0000-4000-8000-000000000001'),('ac250000-0000-4000-8000-000000000002')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ac250000-0000-4000-8000-000000000002'::uuid,p.id,'deny','returns test','ac250000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('sales.returns','inventory.receive','inventory.write_off');
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ac251000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Returns Supplier','FI','ART-SUP'),
 ('ac251000-0000-4000-8000-000000000002',array['customer'],'Returns Customer','KZ','ART-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ac252000-0000-4000-8000-000000000001','ART-001','{"ru":"Товар для возврата"}','ac251000-0000-4000-8000-000000000001','active',400);

create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.fails(text,text) to authenticated;
create temporary table rt(name text primary key,id uuid);
grant select,insert,update on rt to authenticated;
create function pg_temp.id(p_name text) returns uuid language sql as $$ select id from rt where name=p_name $$;
grant execute on function pg_temp.id(text) to authenticated;

insert into rt select 'warehouse',id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('ac253000-0000-4000-8000-000000000001','ac252000-0000-4000-8000-000000000001','ART-EARLY',current_date-100,current_date+200,'ac250000-0000-4000-8000-000000000001'),
 ('ac253000-0000-4000-8000-000000000002','ac252000-0000-4000-8000-000000000001','ART-LATE',current_date-50,current_date+300,'ac250000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ac254000-0000-4000-8000-000000000001','ac253000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',60),
 ('ac254000-0000-4000-8000-000000000002','ac253000-0000-4000-8000-000000000002',pg_temp.id('warehouse'),'piece',100);

set role authenticated;
select set_config('request.jwt.claim.sub','ac250000-0000-4000-8000-000000000001',false);
insert into rt select 'sale',public.create_customer_order('ac251000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date+5,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item',public.add_customer_order_item(pg_temp.id('sale'),'ac252000-0000-4000-8000-000000000001',100,'piece',250,null,'Синтетическая цена теста');
select public.reserve_customer_order_item_fefo(pg_temp.id('item'));
select public.confirm_customer_order(pg_temp.id('sale'));
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),'[{"sale_item_id":"x","batch_id":"y","quantity":1}]')$$,'отгруженному');

-- Shipping: 60 of EARLY (the batch is used up) and 40 of LATE leave the warehouse.
reset role;
update public.inventory_balances b set quantity_on_hand=b.quantity_on_hand-r.quantity, quantity_reserved=b.quantity_reserved-r.quantity
from public.inventory_reservations r where r.inventory_balance_id=b.id and r.sale_item_id=pg_temp.id('item') and r.status='active';
update public.inventory_reservations set status='fulfilled' where sale_item_id=pg_temp.id('item') and status='active';
update public.inventory_batches set status='depleted' where id='ac253000-0000-4000-8000-000000000001';
update public.sales set status='shipped' where id=pg_temp.id('sale');
set role authenticated;
select set_config('request.jwt.claim.sub','ac250000-0000-4000-8000-000000000001',false);

do $$ declare o jsonb := public.customer_return_options(pg_temp.id('sale')); begin
 assert jsonb_array_length(o)=2,'two shipped batches: '||o::text;
 assert (select (e->>'shipped')::numeric=60 and (e->>'available')::numeric=60 from jsonb_array_elements(o) e where e->>'batch_number'='ART-EARLY'),'60 of EARLY shipped';
 assert (select (e->>'shipped')::numeric=40 from jsonb_array_elements(o) e where e->>'batch_number'='ART-LATE'),'40 of LATE shipped';
end $$;


-- ASSISTANT RETURN FIXTURE END
create temporary table art_context(payload jsonb, token uuid);
grant all on art_context to authenticated;
insert into art_context(payload) select jsonb_build_object('sale_id',pg_temp.id('sale'),'reason','Повреждена упаковка','lines',jsonb_build_array(
 jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ac253000-0000-4000-8000-000000000001','quantity','2','reason_code','damaged')));
do $$declare v jsonb; bad jsonb; p jsonb:=(select payload from art_context); begin
 foreach bad in array array[
  p||'{"actor":"ac250000-0000-4000-8000-000000000002"}'::jsonb,
  jsonb_set(p,'{lines,0,quantity}','2'::jsonb),
  jsonb_set(p,'{lines,0,quantity}','"0.0001"'::jsonb),
  jsonb_set(p,'{lines,0,quantity}','"61"'::jsonb),
  jsonb_set(p,'{lines,0,batch_id}','"ac253000-0000-4000-8000-000000000099"'::jsonb),
  jsonb_set(p,'{lines}',(p->'lines')||(p->'lines')),
  jsonb_set(p,'{lines,0}',(p->'lines'->0)||'{"decision":"restock"}'::jsonb)
 ] loop
  perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','customer_return_create',bad::text),'ASSISTANT_RETURN_(INVALID|STATE)');
 end loop;
 v:=public.prepare_assistant_operation('af240000-0000-4000-8000-000000000001','customer_return_create',(select payload from art_context));
 v:=public.review_assistant_operation('af240000-0000-4000-8000-000000000001');
 assert v->>'status'='awaiting_confirmation';
 assert v->'preview'->>'total'='500.00';
 assert not v->'preview' ? 'state_stamp';
 assert not exists(select 1 from public.customer_returns);
 assert (select quantity_on_hand=0 from public.inventory_balances where id='ac254000-0000-4000-8000-000000000001');
 update art_context set token=(v->>'review_token')::uuid;
end $$;
select pg_temp.fails($q$select public.confirm_assistant_operation('af240000-0000-4000-8000-000000000001',gen_random_uuid())$q$,'ASSISTANT_OPERATION_DENIED');
select public.prepare_assistant_operation('af240000-0000-4000-8000-000000000002','customer_return_create',payload) from art_context;
reset role;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id='af240000-0000-4000-8000-000000000002';
select pg_temp.fails($q$select public.confirm_assistant_operation('af240000-0000-4000-8000-000000000002',(select review_token from private.assistant_operations where id='af240000-0000-4000-8000-000000000002'))$q$,'ASSISTANT_OPERATION_EXPIRED');
set role authenticated;
select set_config('request.jwt.claim.sub','ac250000-0000-4000-8000-000000000002',false);
select pg_temp.fails($q$select public.review_assistant_operation('af240000-0000-4000-8000-000000000001')$q$,'ASSISTANT_OPERATION_DENIED');
select set_config('request.jwt.claim.sub','ac250000-0000-4000-8000-000000000001',false);
-- Every required personal deny is honored at execution, including after preparation.
reset role;
do $$declare v_code text; begin
 foreach v_code in array array['agent.use','sales.view','sales.returns','customers.view','products.view','inventory.view','warehouses.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select 'ac250000-0000-4000-8000-000000000001',id,'deny','test','ac250000-0000-4000-8000-000000000001' from public.permissions p where p.code=v_code;
  perform pg_temp.fails($q$select public.confirm_assistant_operation('af240000-0000-4000-8000-000000000001',(select token from art_context))$q$,'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id='ac250000-0000-4000-8000-000000000001';
 end loop;
end $$;
-- A late native failure must roll back header/items/ledger.
create function pg_temp.reject_return() returns trigger language plpgsql as $$begin raise exception 'synthetic failure';end $$;
create trigger synthetic_return_failure before insert on public.customer_return_items for each row execute function pg_temp.reject_return();
set role authenticated;
select pg_temp.fails($q$select public.confirm_assistant_operation('af240000-0000-4000-8000-000000000001',(select token from art_context))$q$,'ASSISTANT_RETURN_REFUSED');
do $$begin assert not exists(select 1 from public.customer_returns);end $$;
reset role;
drop trigger synthetic_return_failure on public.customer_return_items;
-- A price change invalidates the displayed financial effect.
update public.sale_items set unit_price=251 where id=pg_temp.id('item');
set role authenticated;
select pg_temp.fails($q$select public.confirm_assistant_operation('af240000-0000-4000-8000-000000000001',(select token from art_context))$q$,'ASSISTANT_OPERATION_STALE');
reset role;
update public.sale_items set unit_price=250 where id=pg_temp.id('item');
set role authenticated;
-- Explicit fresh preview after source changes.
select public.prepare_assistant_operation('af240000-0000-4000-8000-000000000003','customer_return_create',payload) from art_context;
update art_context set token=(public.review_assistant_operation('af240000-0000-4000-8000-000000000003')->>'review_token')::uuid;
do $$declare a jsonb; b jsonb; begin
 a:=public.confirm_assistant_operation('af240000-0000-4000-8000-000000000003',(select token from art_context));
 b:=public.confirm_assistant_operation('af240000-0000-4000-8000-000000000003',(select token from art_context));
 assert a=b and a->>'status'='completed';
 assert (select count(*)=1 from public.customer_returns);
 assert (select status='quarantine' from public.customer_returns);
 assert (select quantity=2 and unit_price=250 and decision is null from public.customer_return_items);
 assert (select quantity_on_hand=0 from public.inventory_balances where id='ac254000-0000-4000-8000-000000000001');
end $$;
select pg_temp.fails($q$select public.confirm_assistant_operation('af240000-0000-4000-8000-000000000001',(public.review_assistant_operation('af240000-0000-4000-8000-000000000001')->>'review_token')::uuid)$q$,'ASSISTANT_OPERATION_STALE');
reset role;
rollback;
