-- Returns from customers (202609277500): only against a shipped order, never more than shipped per line and batch,
-- quarantine outside the sellable stock, decisions with the right permissions, cancellation.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ad260000-0000-4000-8000-000000000001','assistant-decisions-director@test.local','{"full_name":"Returns Director"}'),
 ('ad260000-0000-4000-8000-000000000002','assistant-decisions-viewer@test.local','{"full_name":"Returns Viewer"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ad260000-0000-4000-8000-000000000001'),('ad260000-0000-4000-8000-000000000002')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ad260000-0000-4000-8000-000000000002'::uuid,p.id,'deny','returns test','ad260000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('sales.returns','inventory.receive','inventory.write_off');
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ad261000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Returns Supplier','FI','ARD-SUP'),
 ('ad261000-0000-4000-8000-000000000002',array['customer'],'Returns Customer','KZ','ARD-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ad262000-0000-4000-8000-000000000001','ARD-001','{"ru":"Товар для возврата"}','ad261000-0000-4000-8000-000000000001','active',400);

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
 ('ad263000-0000-4000-8000-000000000001','ad262000-0000-4000-8000-000000000001','ARD-EARLY',current_date-100,current_date+200,'ad260000-0000-4000-8000-000000000001'),
 ('ad263000-0000-4000-8000-000000000002','ad262000-0000-4000-8000-000000000001','ARD-LATE',current_date-50,current_date+300,'ad260000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ad264000-0000-4000-8000-000000000001','ad263000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',60),
 ('ad264000-0000-4000-8000-000000000002','ad263000-0000-4000-8000-000000000002',pg_temp.id('warehouse'),'piece',100);

set role authenticated;
select set_config('request.jwt.claim.sub','ad260000-0000-4000-8000-000000000001',false);
insert into rt select 'sale',public.create_customer_order('ad261000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date+5,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item',public.add_customer_order_item(pg_temp.id('sale'),'ad262000-0000-4000-8000-000000000001',100,'piece',250,null,'Синтетическая цена теста');
select public.reserve_customer_order_item_fefo(pg_temp.id('item'));
select public.confirm_customer_order(pg_temp.id('sale'));
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),'[{"sale_item_id":"x","batch_id":"y","quantity":1}]')$$,'отгруженному');

-- Shipping: 60 of EARLY (the batch is used up) and 40 of LATE leave the warehouse.
reset role;
update public.inventory_balances b set quantity_on_hand=b.quantity_on_hand-r.quantity, quantity_reserved=b.quantity_reserved-r.quantity
from public.inventory_reservations r where r.inventory_balance_id=b.id and r.sale_item_id=pg_temp.id('item') and r.status='active';
update public.inventory_reservations set status='fulfilled' where sale_item_id=pg_temp.id('item') and status='active';
update public.inventory_batches set status='depleted' where id='ad263000-0000-4000-8000-000000000001';
update public.sales set status='shipped' where id=pg_temp.id('sale');
set role authenticated;
select set_config('request.jwt.claim.sub','ad260000-0000-4000-8000-000000000001',false);

do $$ declare o jsonb := public.customer_return_options(pg_temp.id('sale')); begin
 assert jsonb_array_length(o)=2,'two shipped batches: '||o::text;
 assert (select (e->>'shipped')::numeric=60 and (e->>'available')::numeric=60 from jsonb_array_elements(o) e where e->>'batch_number'='ARD-EARLY'),'60 of EARLY shipped';
 assert (select (e->>'shipped')::numeric=40 from jsonb_array_elements(o) e where e->>'batch_number'='ARD-LATE'),'40 of LATE shipped';
end $$;



create temporary table decision_context(n integer, item uuid, payload jsonb, request uuid, token uuid);
grant all on decision_context to authenticated;
do $$declare d text; n integer:=0; rid uuid; iid uuid; begin
 foreach d in array array['restock','write_off','return_to_supplier'] loop
  n:=n+1;
  rid:=public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ad263000-0000-4000-8000-000000000001','quantity',2,'reason_code','damaged')),'Synthetic return');
  select id into iid from public.customer_return_items where return_id=rid;
  insert into decision_context values(n,iid,jsonb_build_object('item_id',iid,'decision',d,'location_id',null,'note',case when d='restock' then null else 'Причина сотрудника' end),gen_random_uuid(),null);
 end loop;
end $$;
-- DECISION FIXTURE END
do $$declare c decision_context; v jsonb; bad jsonb; begin
 assert jsonb_array_length(public.assistant_return_decision_options(pg_temp.id('sale')))=3;
 for c in select * from decision_context order by n loop
  foreach bad in array array[c.payload||'{"quantity":"1"}'::jsonb,c.payload||'{"actor":"x"}'::jsonb,jsonb_set(c.payload,'{decision}','"cancel"')] loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','customer_return_decide',bad::text),'ASSISTANT_DECISION_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.request,'customer_return_decide',c.payload);
  v:=public.review_assistant_operation(c.request);
  assert v->>'status'='awaiting_confirmation';
  assert not (v->'preview') ? 'state_stamp';
  assert v->'preview'->>'quantity'='2.000';
  update decision_context set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
 assert not exists(select 1 from public.customer_return_items where decision is not null);
 assert (select quantity_on_hand=0 from public.inventory_balances where id='ad264000-0000-4000-8000-000000000001');
end $$;
-- Denial matrix: common permissions plus the decision-specific permission.
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from decision_context;
select set_config('request.jwt.claim.sub','ad260000-0000-4000-8000-000000000002',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',request),'ASSISTANT_OPERATION_DENIED') from decision_context;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_OPERATION_DENIED') from decision_context;
select pg_temp.fails($$select public.assistant_return_decision_options(pg_temp.id('sale'))$$,'ASSISTANT_OPERATION_DENIED');
select set_config('request.jwt.claim.sub','ad260000-0000-4000-8000-000000000001',false);
reset role;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id in(select request from decision_context);
set role authenticated;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_OPERATION_EXPIRED') from decision_context;
reset role;
update private.assistant_operations set expires_at=clock_timestamp()+interval '10 minutes' where id in(select request from decision_context);
do $$declare c decision_context; v_code text; begin
 for c in select * from decision_context loop
  foreach v_code in array array['agent.use','sales.view','customers.view','inventory.view','products.view','warehouses.view',
   case when c.n=1 then 'inventory.receive' else 'inventory.write_off' end] loop
   insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
   select 'ad260000-0000-4000-8000-000000000001',p.id,'deny','test','ad260000-0000-4000-8000-000000000001' from public.permissions p where p.code=v_code;
   perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',c.request,c.token),'ASSISTANT_OPERATION_DENIED');
   delete from public.user_permission_overrides where user_id='ad260000-0000-4000-8000-000000000001';
  end loop;
 end loop;
end $$;
-- Native late failure rolls back the movement and balance, not just the receipt.
create function pg_temp.reject_decision() returns trigger language plpgsql as $$begin raise exception 'synthetic late failure';end $$;
create trigger synthetic_decision_failure before update on public.customer_return_items for each row execute function pg_temp.reject_decision();
set role authenticated;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_DECISION_REFUSED') from decision_context where n=1;
reset role;
drop trigger synthetic_decision_failure on public.customer_return_items;
do $$begin
 assert not exists(select 1 from public.inventory_movements where batch_id='ad263000-0000-4000-8000-000000000001' and movement_type='customer_return');
 assert (select quantity_on_hand=0 from public.inventory_balances where id='ad264000-0000-4000-8000-000000000001');
end $$;
-- A changed batch is stale, not silently made sellable. New preview retains the block.
update public.inventory_batches set status='blocked' where id='ad263000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_OPERATION_STALE') from decision_context;
update decision_context set request=gen_random_uuid();
select public.prepare_assistant_operation(request,'customer_return_decide',payload) from decision_context;
update decision_context set token=(public.review_assistant_operation(request)->>'review_token')::uuid;
do $$declare c decision_context; a jsonb; b jsonb; begin
 for c in select * from decision_context order by n loop
  a:=public.confirm_assistant_operation(c.request,c.token);
  b:=public.confirm_assistant_operation(c.request,c.token);
  assert a=b and a->>'status'='completed';
  assert (select decision=c.payload->>'decision' from public.customer_return_items where id=c.item);
  perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','customer_return_decide',c.payload::text),'ASSISTANT_DECISION_STATE');
 end loop;
 assert (select quantity_on_hand=2 from public.inventory_balances where id='ad264000-0000-4000-8000-000000000001');
 assert (select status='blocked' from public.inventory_batches where id='ad263000-0000-4000-8000-000000000001');
 assert (select count(*)=1 from public.inventory_movements where batch_id='ad263000-0000-4000-8000-000000000001' and movement_type='customer_return');
 assert (select count(*)=3 from public.customer_returns where sale_id=pg_temp.id('sale') and status='closed');
end $$;
reset role;
rollback;
