-- Returns from customers (202609277500): only against a shipped order, never more than shipped per line and batch,
-- quarantine outside the sellable stock, decisions with the right permissions, cancellation.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ac280000-0000-4000-8000-000000000001','assistant-cancellation-director@test.local','{"full_name":"Returns Director"}'),
 ('ac280000-0000-4000-8000-000000000002','assistant-cancellation-viewer@test.local','{"full_name":"Returns Viewer"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ac280000-0000-4000-8000-000000000001'),('ac280000-0000-4000-8000-000000000002')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ac280000-0000-4000-8000-000000000002'::uuid,p.id,'deny','returns test','ac280000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('sales.returns','inventory.receive','inventory.write_off');
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ac281000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Returns Supplier','FI','ARC-SUP'),
 ('ac281000-0000-4000-8000-000000000002',array['customer'],'Returns Customer','KZ','ARC-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ac282000-0000-4000-8000-000000000001','ARC-001','{"ru":"Товар для возврата"}','ac281000-0000-4000-8000-000000000001','active',400);

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
 ('ac283000-0000-4000-8000-000000000001','ac282000-0000-4000-8000-000000000001','ARC-EARLY',current_date-100,current_date+200,'ac280000-0000-4000-8000-000000000001'),
 ('ac283000-0000-4000-8000-000000000002','ac282000-0000-4000-8000-000000000001','ARC-LATE',current_date-50,current_date+300,'ac280000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ac284000-0000-4000-8000-000000000001','ac283000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',60),
 ('ac284000-0000-4000-8000-000000000002','ac283000-0000-4000-8000-000000000002',pg_temp.id('warehouse'),'piece',100);

set role authenticated;
select set_config('request.jwt.claim.sub','ac280000-0000-4000-8000-000000000001',false);
insert into rt select 'sale',public.create_customer_order('ac281000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date+5,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item',public.add_customer_order_item(pg_temp.id('sale'),'ac282000-0000-4000-8000-000000000001',100,'piece',250,null);
select public.reserve_customer_order_item_fefo(pg_temp.id('item'));
select public.confirm_customer_order(pg_temp.id('sale'));
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),'[{"sale_item_id":"x","batch_id":"y","quantity":1}]')$$,'отгруженному');

-- Shipping: 60 of EARLY (the batch is used up) and 40 of LATE leave the warehouse.
reset role;
update public.inventory_balances b set quantity_on_hand=b.quantity_on_hand-r.quantity, quantity_reserved=b.quantity_reserved-r.quantity
from public.inventory_reservations r where r.inventory_balance_id=b.id and r.sale_item_id=pg_temp.id('item') and r.status='active';
update public.inventory_reservations set status='fulfilled' where sale_item_id=pg_temp.id('item') and status='active';
update public.inventory_batches set status='depleted' where id='ac283000-0000-4000-8000-000000000001';
update public.sales set status='shipped' where id=pg_temp.id('sale');
set role authenticated;
select set_config('request.jwt.claim.sub','ac280000-0000-4000-8000-000000000001',false);

do $$ declare o jsonb := public.customer_return_options(pg_temp.id('sale')); begin
 assert jsonb_array_length(o)=2,'two shipped batches: '||o::text;
 assert (select (e->>'shipped')::numeric=60 and (e->>'available')::numeric=60 from jsonb_array_elements(o) e where e->>'batch_number'='ARC-EARLY'),'60 of EARLY shipped';
 assert (select (e->>'shipped')::numeric=40 from jsonb_array_elements(o) e where e->>'batch_number'='ARC-LATE'),'40 of LATE shipped';
end $$;



create temporary table cancel_context(n integer, return_id uuid, payload jsonb, request uuid, token uuid);
grant all on cancel_context to authenticated;
do $$declare n integer; rid uuid;begin
 for n in 1..4 loop
  rid:=public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ac283000-0000-4000-8000-000000000001','quantity',2,'reason_code','damaged')),'Synthetic return');
  insert into cancel_context values(n,rid,jsonb_build_object('return_id',rid,'reason','Возврат оформлен ошибочно'),gen_random_uuid(),null);
 end loop;
end $$;
-- CANCELLATION FIXTURE END
do $$declare c cancel_context; v jsonb; bad jsonb;begin
 assert jsonb_array_length(public.assistant_return_cancellation_options(pg_temp.id('sale')))=4;
 for c in select * from cancel_context loop
  foreach bad in array array[c.payload||'{"quantity":"1"}'::jsonb,c.payload||'{"actor":"x"}'::jsonb,jsonb_set(c.payload,'{reason}','""')] loop
   perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','customer_return_cancel',bad::text),'ASSISTANT_CANCEL_INVALID');
  end loop;
  perform public.prepare_assistant_operation(c.request,'customer_return_cancel',c.payload);
  v:=public.review_assistant_operation(c.request);
  assert v->>'status'='awaiting_confirmation' and v->'preview'->>'total'='500.00';
  assert not (v->'preview') ? 'state_stamp';
  update cancel_context set token=(v->>'review_token')::uuid where n=c.n;
 end loop;
 assert (select count(*)=4 from public.customer_returns where sale_id=pg_temp.id('sale') and status='quarantine');
end $$;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,gen_random_uuid()),'ASSISTANT_OPERATION_DENIED') from cancel_context;
select set_config('request.jwt.claim.sub','ac280000-0000-4000-8000-000000000002',false);
select pg_temp.fails(format('select public.review_assistant_operation(%L)',request),'ASSISTANT_OPERATION_DENIED') from cancel_context;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_OPERATION_DENIED') from cancel_context;
select pg_temp.fails($$select public.assistant_return_cancellation_options(pg_temp.id('sale'))$$,'ASSISTANT_OPERATION_DENIED');
select set_config('request.jwt.claim.sub','ac280000-0000-4000-8000-000000000001',false);
reset role;
update private.assistant_operations set expires_at=clock_timestamp()-interval '1 second' where id in(select request from cancel_context);
set role authenticated;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_OPERATION_EXPIRED') from cancel_context;
reset role;
update private.assistant_operations set expires_at=clock_timestamp()+interval '10 minutes' where id in(select request from cancel_context);
do $$declare c cancel_context; v_code text;begin
 select * into c from cancel_context where n=1;
 foreach v_code in array array['agent.use','sales.view','sales.returns','customers.view','inventory.view','products.view','warehouses.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
  select 'ac280000-0000-4000-8000-000000000001',id,'deny','test','ac280000-0000-4000-8000-000000000001' from public.permissions where code=v_code;
  perform pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',c.request,c.token),'ASSISTANT_OPERATION_DENIED');
  delete from public.user_permission_overrides where user_id='ac280000-0000-4000-8000-000000000001';
 end loop;
end $$;
create function pg_temp.reject_cancel() returns trigger language plpgsql as $$begin raise exception 'synthetic late failure';end $$;
create trigger synthetic_cancel_failure after update on public.customer_returns for each row execute function pg_temp.reject_cancel();
set role authenticated;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_CANCEL_REFUSED') from cancel_context where n=1;
reset role;
drop trigger synthetic_cancel_failure on public.customer_returns;
do $$begin
 assert (select count(*)=4 from public.customer_returns where sale_id=pg_temp.id('sale') and status='quarantine');
 assert not exists(select 1 from private.assistant_operations where id in(select request from cancel_context) and result_return_id is not null);
 assert (select sum(amount)=-2000 from private.customer_ledger('ac281000-0000-4000-8000-000000000002') where kind='return');
end $$;
set role authenticated;
do $$declare c cancel_context; a jsonb; b jsonb;begin
 select * into c from cancel_context where n=1;
 a:=public.confirm_assistant_operation(c.request,c.token); b:=public.confirm_assistant_operation(c.request,c.token);
 assert a=b and a->>'status'='completed';
 assert (select status='cancelled' and cancellation_reason=c.payload->>'reason' from public.customer_returns where id=c.return_id);
 perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','customer_return_cancel',c.payload::text),'ASSISTANT_CANCEL_STATE');
 assert (select (e->>'available')::numeric=54 from jsonb_array_elements(public.customer_return_options(pg_temp.id('sale'))) e where e->>'batch_number'='ARC-EARLY');
end $$;
-- Any decision, including non-stock disposition, makes cancellation unavailable.
select public.decide_customer_return_item((select ri.id from public.customer_return_items ri join cancel_context c on c.return_id=ri.return_id where c.n=2),'write_off',null,'Повреждение');
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_CANCEL_STATE') from cancel_context where n=2;
select public.cancel_customer_return(return_id,'Отменено штатной формой') from cancel_context where n=3;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_CANCEL_STATE') from cancel_context where n=3;
reset role;
update public.customer_returns set reason='Изменился источник' where id=(select return_id from cancel_context where n=4);
set role authenticated;
select pg_temp.fails(format('select public.confirm_assistant_operation(%L,%L)',request,token),'ASSISTANT_OPERATION_STALE') from cancel_context where n=4;
reset role;
do $$begin
 assert (select sum(amount)=-1000 from private.customer_ledger('ac281000-0000-4000-8000-000000000002') where kind='return');
 assert (select quantity_on_hand=0 from public.inventory_balances where id='ac284000-0000-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_movements where batch_id='ac283000-0000-4000-8000-000000000001' and movement_type='customer_return');
 assert (select count(*)=4 from public.customer_return_items ri join public.customer_returns cr on cr.id=ri.return_id where cr.sale_id=pg_temp.id('sale'));
end $$;
-- A partially decided multi-line return is still quarantine, but cannot be cancelled.
set role authenticated;
do $$declare rid uuid; iid uuid;begin
 rid:=public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(
  jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ac283000-0000-4000-8000-000000000001','quantity',1,'reason_code','damaged'),
  jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ac283000-0000-4000-8000-000000000002','quantity',1,'reason_code','damaged')),'Несколько позиций');
 select id into iid from public.customer_return_items where return_id=rid and batch_id='ac283000-0000-4000-8000-000000000001';
 perform public.decide_customer_return_item(iid,'write_off',null,'Повреждение');
 assert (select status='quarantine' from public.customer_returns where id=rid);
 assert (select count(*)=1 from public.customer_return_items where return_id=rid and decision is null);
 perform pg_temp.fails(format('select public.prepare_assistant_operation(gen_random_uuid(),%L,%L::jsonb)','customer_return_cancel',jsonb_build_object('return_id',rid,'reason','Отмена')::text),'ASSISTANT_CANCEL_STATE');
 assert not exists(select 1 from jsonb_array_elements(public.assistant_return_cancellation_options(pg_temp.id('sale'))) e where (e->>'return_id')::uuid=rid);
end $$;
reset role;
rollback;

