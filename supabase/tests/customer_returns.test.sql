-- Returns from customers (202609277500): only against a shipped order, never more than shipped per line and batch,
-- quarantine outside the sellable stock, decisions with the right permissions, cancellation.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ee000000-0000-4000-8000-000000000001','returns-director@test.local','{"full_name":"Returns Director"}'),
 ('ee000000-0000-4000-8000-000000000002','returns-viewer@test.local','{"full_name":"Returns Viewer"}');
insert into public.user_roles(user_id,role_id) select u::uuid,r.id from (values
 ('ee000000-0000-4000-8000-000000000001'),('ee000000-0000-4000-8000-000000000002')) v(u)
 cross join public.app_roles r where r.code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ee000000-0000-4000-8000-000000000002'::uuid,p.id,'deny','returns test','ee000000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('sales.returns','inventory.receive','inventory.write_off');
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ee100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Returns Supplier','FI','RET-SUP'),
 ('ee100000-0000-4000-8000-000000000002',array['customer'],'Returns Customer','KZ','RET-CUS');
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ee200000-0000-4000-8000-000000000001','RET-001','{"ru":"Товар для возврата"}','ee100000-0000-4000-8000-000000000001','active',400);

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
 ('ee300000-0000-4000-8000-000000000001','ee200000-0000-4000-8000-000000000001','RET-EARLY',current_date-100,current_date+200,'ee000000-0000-4000-8000-000000000001'),
 ('ee300000-0000-4000-8000-000000000002','ee200000-0000-4000-8000-000000000001','RET-LATE',current_date-50,current_date+300,'ee000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ee400000-0000-4000-8000-000000000001','ee300000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',60),
 ('ee400000-0000-4000-8000-000000000002','ee300000-0000-4000-8000-000000000002',pg_temp.id('warehouse'),'piece',100);

set role authenticated;
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',false);
insert into rt select 'sale',public.create_customer_order('ee100000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date+5,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item',public.add_customer_order_item(pg_temp.id('sale'),'ee200000-0000-4000-8000-000000000001',100,'piece',250,null,'Синтетическая цена теста');
select public.reserve_customer_order_item_fefo(pg_temp.id('item'));
select public.confirm_customer_order(pg_temp.id('sale'));
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),'[{"sale_item_id":"x","batch_id":"y","quantity":1}]')$$,'отгруженному');

-- Shipping: 60 of EARLY (the batch is used up) and 40 of LATE leave the warehouse.
reset role;
update public.inventory_balances b set quantity_on_hand=b.quantity_on_hand-r.quantity, quantity_reserved=b.quantity_reserved-r.quantity
from public.inventory_reservations r where r.inventory_balance_id=b.id and r.sale_item_id=pg_temp.id('item') and r.status='active';
update public.inventory_reservations set status='fulfilled' where sale_item_id=pg_temp.id('item') and status='active';
update public.inventory_batches set status='depleted' where id='ee300000-0000-4000-8000-000000000001';
update public.sales set status='shipped' where id=pg_temp.id('sale');
set role authenticated;
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',false);

do $$ declare o jsonb := public.customer_return_options(pg_temp.id('sale')); begin
 assert jsonb_array_length(o)=2,'two shipped batches: '||o::text;
 assert (select (e->>'shipped')::numeric=60 and (e->>'available')::numeric=60 from jsonb_array_elements(o) e where e->>'batch_number'='RET-EARLY'),'60 of EARLY shipped';
 assert (select (e->>'shipped')::numeric=40 from jsonb_array_elements(o) e where e->>'batch_number'='RET-LATE'),'40 of LATE shipped';
end $$;

-- ---------- rights and validation ----------
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000001','quantity',5)))$$,'Недостаточно прав');
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000002','quantity',41)))$$,'больше отгруженного: доступно к возврату 40');
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000001','quantity',1),jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000001','quantity',1)))$$,'дважды');
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id','ee900000-0000-4000-8000-000000000001','batch_id','ee300000-0000-4000-8000-000000000001','quantity',1)))$$,'не относится к этому заказу');
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000001','quantity',0)))$$,'больше нуля');
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000001','quantity',1,'reason_code','mood')))$$,'причина');
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),'[]')$$,'хотя бы одну');
select pg_temp.fails($$insert into public.customer_returns(return_number,sale_id,customer_id,warehouse_id) values('X',pg_temp.id('sale'),'ee100000-0000-4000-8000-000000000002',pg_temp.id('warehouse'))$$,'permission denied');
do $$ begin assert not exists(select 1 from public.customer_returns),'refused returns left nothing'; end $$;

-- ---------- a return: quarantine, outside the sellable stock ----------
insert into rt select 'return',public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(
  jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000001','quantity',10,'reason_code','damaged'),
  jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000002','quantity',5,'reason_code','refused')),'Клиент вернул часть товара');
do $$ begin
 assert (select status='quarantine' and return_number like 'RT-%' and customer_id='ee100000-0000-4000-8000-000000000002' from public.customer_returns where id=pg_temp.id('return')),'return in quarantine';
 assert (select count(*)=2 and bool_and(unit_price=250) and bool_and(decision is null) from public.customer_return_items where return_id=pg_temp.id('return')),'lines keep the order price';
 assert (select quantity_on_hand=0 from public.inventory_balances where id='ee400000-0000-4000-8000-000000000001'),'quarantine does not add sellable stock';
 assert (select (e->>'available')::numeric=50 from jsonb_array_elements(public.customer_return_options(pg_temp.id('sale'))) e where e->>'batch_number'='RET-EARLY'),'room shrinks by the return';
end $$;
select pg_temp.fails($$select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000002','quantity',36)))$$,'доступно к возврату 35');

-- ---------- decisions ----------
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select public.decide_customer_return_item((select id from public.customer_return_items where batch_id='ee300000-0000-4000-8000-000000000001'),'restock')$$,'Недостаточно прав');
select set_config('request.jwt.claim.sub','ee000000-0000-4000-8000-000000000001',false);
select pg_temp.fails($$select public.decide_customer_return_item((select id from public.customer_return_items where batch_id='ee300000-0000-4000-8000-000000000002'),'write_off')$$,'Укажите причину');
select public.decide_customer_return_item((select id from public.customer_return_items where batch_id='ee300000-0000-4000-8000-000000000001'),'restock',null,'Упаковка цела после осмотра');
do $$ begin
 assert (select sum(quantity_on_hand)=10 from public.inventory_balances where batch_id='ee300000-0000-4000-8000-000000000001'),'restocked into the batch';
 assert (select status='available' from public.inventory_batches where id='ee300000-0000-4000-8000-000000000001'),'a used-up batch is available again';
 assert exists(select 1 from public.inventory_movements m join public.customer_return_items i on i.inventory_movement_id=m.id
               where m.movement_type='customer_return' and m.quantity=10 and m.to_warehouse_id=pg_temp.id('warehouse')),'a customer_return movement';
 assert (select status='quarantine' from public.customer_returns where id=pg_temp.id('return')),'one line still waits for a decision';
end $$;
select pg_temp.fails($$select public.decide_customer_return_item((select id from public.customer_return_items where batch_id='ee300000-0000-4000-8000-000000000001'),'write_off',null,'x')$$,'уже принято');
select pg_temp.fails($$select public.cancel_customer_return(pg_temp.id('return'),'Ошибка')$$,'уже приняты решения');
select public.decide_customer_return_item((select id from public.customer_return_items where batch_id='ee300000-0000-4000-8000-000000000002'),'write_off',null,'Вскрыта упаковка');
do $$ begin
 assert (select sum(quantity_on_hand)=60 from public.inventory_balances where batch_id='ee300000-0000-4000-8000-000000000002'),'a write-off adds nothing to stock';
 assert (select status='closed' from public.customer_returns where id=pg_temp.id('return')),'all lines decided: closed';
end $$;

-- ---------- cancellation gives the room back ----------
insert into rt select 'return2',public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(
  jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ee300000-0000-4000-8000-000000000002','quantity',35)));
select pg_temp.fails($$select public.cancel_customer_return(pg_temp.id('return2'),' ')$$,'причину');
select public.cancel_customer_return(pg_temp.id('return2'),'Клиент передумал');
do $$ begin
 assert (select status='cancelled' from public.customer_returns where id=pg_temp.id('return2')),'cancelled';
 assert (select (e->>'available')::numeric=35 from jsonb_array_elements(public.customer_return_options(pg_temp.id('sale'))) e where e->>'batch_number'='RET-LATE'),'room is back';
end $$;
select pg_temp.fails($$select public.decide_customer_return_item((select id from public.customer_return_items where return_id=pg_temp.id('return2')),'restock')$$,'отменён');

reset role;
rollback;
