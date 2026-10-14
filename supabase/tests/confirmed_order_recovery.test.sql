-- Audit finding Н5: a confirmed order is repaired instead of cancelled. Batches are replaced and the shipment
-- date moved with a reason, letters that no longer match are superseded, confirmation checks the batches and
-- blocking a batch warns the orders reserved on it.
-- supabase/tests/before/202609278100_confirmed_order_recovery.sql shows the same scenarios as dead ends before.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('c5000000-0000-4000-8000-000000000001','order-director@test.local','{"full_name":"Order Director"}'),
 ('c5000000-0000-4000-8000-000000000002','order-logistics@test.local','{"full_name":"Order Senior Logistics"}'),
 ('c5000000-0000-4000-8000-000000000003','order-warehouse@test.local','{"full_name":"Order Warehouse"}'),
 ('c5000000-0000-4000-8000-000000000004','order-accountant@test.local','{"full_name":"Order Accountant"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values('c5000000-0000-4000-8000-000000000001','director'),('c5000000-0000-4000-8000-000000000002','senior_logistics_manager'),
 ('c5000000-0000-4000-8000-000000000003','logistics_specialist'),('c5000000-0000-4000-8000-000000000004','accountant'))u(id,code)
join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'c5000000-0000-4000-8000-000000000004',id,'deny','order test','c5000000-0000-4000-8000-000000000001' from public.permissions where code='sales.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('c5100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Order factory','FI','OR-M'),
 ('c5100000-0000-4000-8000-000000000002',array['customer'],'Order buyer','KZ','OR-C');
insert into public.warehouses(id,code,name,city,country) values
 ('c5200000-0000-4000-8000-000000000001','OR-WH','{"ru":"Склад заказов"}','Актобе','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,shelf_life_days) values
 ('c5300000-0000-4000-8000-000000000001','OR-BLOCK','{"ru":"Товар для блокировки"}','c5100000-0000-4000-8000-000000000001',400),
 ('c5300000-0000-4000-8000-000000000002','OR-EXPIRE','{"ru":"Товар, который просрочится"}','c5100000-0000-4000-8000-000000000001',400),
 ('c5300000-0000-4000-8000-000000000003','OR-DELAY','{"ru":"Товар со сроком 100 дней"}','c5100000-0000-4000-8000-000000000001',100),
 ('c5300000-0000-4000-8000-000000000004','OR-PLAIN','{"ru":"Обычный товар"}','c5100000-0000-4000-8000-000000000001',400),
 ('c5300000-0000-4000-8000-000000000005','OR-PAST','{"ru":"Товар для просроченной даты"}','c5100000-0000-4000-8000-000000000001',400);
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('c5400000-0000-4000-8000-000000000001','c5300000-0000-4000-8000-000000000001','OR-BLOCK-1',current_date-10,current_date+200,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000002','c5300000-0000-4000-8000-000000000001','OR-BLOCK-2',current_date-10,current_date+250,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000003','c5300000-0000-4000-8000-000000000002','OR-EXPIRE-1',current_date-10,current_date+100,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000004','c5300000-0000-4000-8000-000000000002','OR-EXPIRE-2',current_date-10,current_date+200,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000005','c5300000-0000-4000-8000-000000000003','OR-DELAY-1',current_date-20,current_date+80,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000009','c5300000-0000-4000-8000-000000000003','OR-DELAY-2',current_date-5,current_date+95,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000006','c5300000-0000-4000-8000-000000000004','OR-PLAIN-1',current_date-10,current_date+300,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000007','c5300000-0000-4000-8000-000000000005','OR-PAST-1',current_date-301,current_date-1,'c5000000-0000-4000-8000-000000000001'),
 ('c5400000-0000-4000-8000-000000000008','c5300000-0000-4000-8000-000000000005','OR-PAST-2',current_date-200,current_date+200,'c5000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand)
select id,'c5200000-0000-4000-8000-000000000001','piece',case when batch_number='OR-BLOCK-2' then 15 else 100 end
from public.inventory_batches where batch_number like 'OR-%';
create temporary table oc(k text primary key,id uuid);
grant all on oc to authenticated;

create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
 execute p_sql;
 raise exception 'expected a failure: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;
 when others then
  if position(p_expected in sqlerrm)=0 and sqlstate<>p_expected then raise exception 'unexpected error for %: % (%)',p_sql,sqlerrm,sqlstate;end if;
end $$;
create function pg_temp.oc(p_k text) returns uuid language sql stable as $$select id from oc where k=p_k$$;
create function pg_temp.as_user(p_n int) returns void language sql as $$select set_config('request.jwt.claim.sub',format('c5000000-0000-4000-8000-%s',lpad(p_n::text,12,'0')),false)$$;
create function pg_temp.reserved_batches(p_item uuid) returns text language sql stable as $$
 select string_agg(b.batch_number||':'||trim_scale(r.sale_quantity),',' order by b.batch_number) from public.inventory_reservations r
 join public.inventory_batches b on b.id=r.batch_id where r.sale_item_id=p_item and r.status='active'$$;

set role authenticated;
select pg_temp.as_user(1);
-- block: 10 pieces confirmed, block-reserved: 8 pieces reserved but not confirmed (both on OR-BLOCK-1, OR-BLOCK-2 has 15);
-- expire: 10 pieces confirmed; delay: 10 pieces of the 100-day product, 74 % required, 75 % at the planned date;
-- letter: a low shelf-life line with a sent letter and an ordinary line.
insert into oc select 'sale-'||p.k,public.create_customer_order('c5100000-0000-4000-8000-000000000002',null,'c5200000-0000-4000-8000-000000000001',current_date+5,null,'Заказ '||p.k)
from (values('block'),('block-reserved'),('expire'),('delay'),('letter'))p(k);
insert into oc select 'item-'||p.k,public.add_customer_order_item(pg_temp.oc('sale-'||p.s),p.product::uuid,p.qty,'piece',null,p.required)
from (values('block','block','c5300000-0000-4000-8000-000000000001',10,null::numeric),('block-reserved','block-reserved','c5300000-0000-4000-8000-000000000001',8,null),
 ('expire','expire','c5300000-0000-4000-8000-000000000002',10,null),('delay','delay','c5300000-0000-4000-8000-000000000003',10,74),
 ('letter-low','letter','c5300000-0000-4000-8000-000000000003',5,76),('letter-plain','letter','c5300000-0000-4000-8000-000000000004',5,null))p(k,s,product,qty,required);
select public.reserve_customer_order_item_fefo(id) from oc where k like 'item-%' order by k;
insert into oc select 'letter-1',public.create_sale_guarantee_letter(pg_temp.oc('sale-letter'),'Первое письмо');
select public.change_sale_guarantee_status(pg_temp.oc('letter-1'),'approved');
select public.change_sale_guarantee_status(pg_temp.oc('letter-1'),'sent');
select public.confirm_customer_order(id) from oc where k in ('sale-block','sale-expire','sale-delay','sale-letter');

-- 1. Blocking a batch: the open orders on it are warned, confirmation refuses it, the confirmed order is repaired.
select pg_temp.as_user(3);
select public.set_inventory_batch_status('c5400000-0000-4000-8000-000000000001','blocked','Отзыв производителя');
reset role;
do $$begin
 assert (select count(*)=2 and bool_and(recipient_user_id='c5000000-0000-4000-8000-000000000001' and type='status_change' and entity_type='sale')
  and bool_and(title like 'Партия OR-BLOCK-1 заблокирована: заказ %' and body like '%Отзыв производителя%')
  from public.notifications where entity_id in (pg_temp.oc('sale-block'),pg_temp.oc('sale-block-reserved'))),
  'the creator of each open order on the batch is warned once';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_failure(format('select public.confirm_customer_order(%L)',pg_temp.oc('sale-block-reserved')),'Партии OR-BLOCK-1 заблокированы');
select pg_temp.expect_failure(format('select public.fulfill_customer_order(%L)',pg_temp.oc('sale-block')),'Партия заблокирована');
-- The ordinary reservation stays reserved to draft and reserved orders.
select pg_temp.expect_failure(format('select public.reserve_customer_order_item_fefo(%L)',pg_temp.oc('item-block')),'Заказ недоступен для резервирования');
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,null,%L)',pg_temp.oc('item-block'),'  '),'Укажите причину перерезервирования');
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,null,%L)',pg_temp.oc('item-block'),repeat('я',501)),'длиннее 500');
-- The senior logistics manager reserves goods but does not manage orders: a confirmed order is not theirs to change.
select pg_temp.as_user(2);
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,null,%L)',pg_temp.oc('item-block'),'Отзыв'),'42501');
select pg_temp.as_user(1);
select public.rereserve_customer_order_item(pg_temp.oc('item-block'),null,'Партия OR-BLOCK-1 отозвана производителем');
reset role;
do $$begin
 assert pg_temp.reserved_batches(pg_temp.oc('item-block'))='OR-BLOCK-2:10','FEFO moved the line to the other batch';
 assert (select status='confirmed' from public.sales where id=pg_temp.oc('sale-block')),'the order stays confirmed';
 assert (select quantity_reserved=8 from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000001'),
  'only the reserved order is left on the blocked batch';
 assert (select count(*)=1 and min(action)='rereserve' and min(reason)='Партия OR-BLOCK-1 отозвана производителем'
  and min(created_by::text)='c5000000-0000-4000-8000-000000000001'
  and min(details->'before'->0->>'batch_number')='OR-BLOCK-1' and min(details->'after'->0->>'batch_number')='OR-BLOCK-2'
  and bool_and((details->>'fefo')::boolean) and not bool_or((details->>'letter_superseded')::boolean)
  from public.sale_revisions where sale_id=pg_temp.oc('sale-block') and sale_item_id=pg_temp.oc('item-block')),'the replacement is recorded with its reason';
end$$;
set role authenticated;
select pg_temp.as_user(1);
-- Not enough fresh stock for the reserved order (8 pieces, 5 left on OR-BLOCK-2): nothing changes.
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,null,%L)',pg_temp.oc('item-block-reserved'),'Партия отозвана'),
 'Недостаточный доступный остаток: не хватает 3');
reset role;
do $$begin
 assert pg_temp.reserved_batches(pg_temp.oc('item-block-reserved'))='OR-BLOCK-1:8','a failed replacement keeps the current reservation';
 assert (select status='reserved' from public.sales where id=pg_temp.oc('sale-block-reserved')),'and the order status';
 assert not exists(select 1 from public.sale_revisions where sale_id=pg_temp.oc('sale-block-reserved')),'and records nothing';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select public.fulfill_customer_order(pg_temp.oc('sale-block'));
-- Blocking the batch the shipped order took warns nobody: only open orders with an active reservation count.
select pg_temp.as_user(3);
select public.set_inventory_batch_status('c5400000-0000-4000-8000-000000000002','blocked','Проверка качества');
reset role;
do $$begin
 assert (select count(*)=1 from public.notifications where entity_id=pg_temp.oc('sale-block')),'a shipped order is not warned again';
end$$;
set role authenticated;
select pg_temp.as_user(1);

-- 2. An expired batch: a manual pick needs the FEFO override permission and keeps its reason.
reset role;
update public.inventory_batches set expiry_date=current_date-1 where id='c5400000-0000-4000-8000-000000000003';
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_failure(format('select public.fulfill_customer_order(%L)',pg_temp.oc('sale-expire')),'просрочена');
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,%L,%L)',pg_temp.oc('item-expire'),
 (select id from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000003'),'Та же партия'),'Партию нельзя резервировать на дату отгрузки');
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'c5000000-0000-4000-8000-000000000001',id,'deny','order test','c5000000-0000-4000-8000-000000000001' from public.permissions where code='sales.override_fefo';
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,%L,%L)',pg_temp.oc('item-expire'),
 (select id from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000004'),'Свежая партия'),'42501');
reset role;
delete from public.user_permission_overrides where user_id='c5000000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.as_user(1);
select public.rereserve_customer_order_item(pg_temp.oc('item-expire'),(select id from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000004'),'Партия просрочилась до отгрузки');
reset role;
do $$begin
 assert (select count(*)=1 and bool_and(is_fefo_override and override_reason='Партия просрочилась до отгрузки')
  from public.inventory_reservations where sale_item_id=pg_temp.oc('item-expire') and status='active' and batch_id='c5400000-0000-4000-8000-000000000004'),
  'the manual pick is marked as a FEFO override with the reason';
 assert (select not (details->>'fefo')::boolean from public.sale_revisions where sale_item_id=pg_temp.oc('item-expire')),'and recorded as manual';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select public.fulfill_customer_order(pg_temp.oc('sale-expire'));

-- 3. A delayed shipment: moving the date recalculates the shelf life; the letter is then issued for the confirmed order.
select pg_temp.expect_failure(format('select public.reschedule_customer_order(%L,%L,%L)',pg_temp.oc('sale-delay'),current_date-1,'Задержка'),'не раньше сегодняшнего дня');
select pg_temp.expect_failure(format('select public.reschedule_customer_order(%L,%L,%L)',pg_temp.oc('sale-delay'),current_date+5,'Задержка'),'Дата отгрузки не изменилась');
select pg_temp.expect_failure(format('select public.reschedule_customer_order(%L,%L,%L)',pg_temp.oc('sale-delay'),current_date+7,''),'Укажите причину переноса');
select pg_temp.as_user(2);
select pg_temp.expect_failure(format('select public.reschedule_customer_order(%L,%L,%L)',pg_temp.oc('sale-delay'),current_date+7,'Задержка'),'42501');
select pg_temp.as_user(1);
select public.reschedule_customer_order(pg_temp.oc('sale-delay'),current_date+7,'Машина клиента опаздывает на два дня');
reset role;
do $$begin
 assert (select planned_shipment_date=current_date+7 and status='confirmed' from public.sales where id=pg_temp.oc('sale-delay')),'the date moved, the order is still confirmed';
 assert (select remaining_shelf_life_pct=73 from public.inventory_reservations where sale_item_id=pg_temp.oc('item-delay') and status='active'),'73 % on the new date';
 assert (select details->>'from'=(current_date+5)::text and details->>'to'=(current_date+7)::text and details->>'unfit_batches' is null
  from public.sale_revisions where sale_id=pg_temp.oc('sale-delay') and action='reschedule'),'the move is recorded';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_failure(format('select public.fulfill_customer_order(%L)',pg_temp.oc('sale-delay')),'гарантийного письма');
insert into oc select 'letter-delay',public.create_sale_guarantee_letter(pg_temp.oc('sale-delay'),'Задержка отгрузки');
select public.change_sale_guarantee_status(pg_temp.oc('letter-delay'),'approved');
select public.fulfill_customer_order(pg_temp.oc('sale-delay'));
select pg_temp.expect_failure(format('select public.reschedule_customer_order(%L,%L,%L)',pg_temp.oc('sale-delay'),current_date+9,'Ещё'),'Заказ недоступен для переноса');
select pg_temp.expect_failure(format('select public.rereserve_customer_order_item(%L,null,%L)',pg_temp.oc('item-delay'),'Ещё'),'Заказ недоступен для перерезервирования');

-- 4. A fixed letter stays while it still matches the reservations and is superseded when it does not.
select public.rereserve_customer_order_item(pg_temp.oc('item-letter-plain'),null,'Переставили на другую ячейку');
reset role;
do $$begin
 assert (select status='sent' from public.guarantee_letters where id=pg_temp.oc('letter-1')),'replacing an ordinary line keeps the sent letter';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_failure(format('select public.create_sale_guarantee_letter(%L,%L)',pg_temp.oc('sale-letter'),'Второе'),'уже есть действующее гарантийное письмо');
select public.reschedule_customer_order(pg_temp.oc('sale-letter'),current_date+6,'Клиент перенёс приёмку');
reset role;
do $$begin
 assert (select status='superseded' and superseded_at is not null and superseded_reason='Отгрузка перенесена: Клиент перенёс приёмку'
  and sent_at is not null from public.guarantee_letters where id=pg_temp.oc('letter-1')),'the letter for the old date is superseded and keeps its history';
 assert (select (details->>'letter_superseded')::boolean from public.sale_revisions where sale_id=pg_temp.oc('sale-letter') and action='reschedule'),'and the move says so';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select pg_temp.expect_failure(format('select public.change_sale_guarantee_status(%L,%L)',pg_temp.oc('letter-1'),'approved'),'Недопустимый переход');
insert into oc select 'letter-2',public.create_sale_guarantee_letter(pg_temp.oc('sale-letter'),'Новая дата');
reset role;
do $$begin
 assert (select letter_number<>(select letter_number from public.guarantee_letters where id=pg_temp.oc('letter-1')) and status='draft'
  from public.guarantee_letters where id=pg_temp.oc('letter-2')),'a new letter with its own number';
 assert (select count(*)=2 from public.guarantee_letters where sale_id=pg_temp.oc('sale-letter')),'both letters are kept';
 begin
  insert into public.guarantee_letters(letter_number,customer_id,sale_id) values('GL-TEST-DUP','c5100000-0000-4000-8000-000000000002',pg_temp.oc('sale-letter'));
  raise exception 'second current letter accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when unique_violation then null;
 end;
end$$;
set role authenticated;
select pg_temp.as_user(1);
select public.change_sale_guarantee_status(pg_temp.oc('letter-2'),'approved');
reset role;
do $$begin
 begin
  insert into public.guarantee_letters(letter_number,customer_id,sale_id) values('GL-TEST-DUP2','c5100000-0000-4000-8000-000000000002',pg_temp.oc('sale-letter'));
  raise exception 'a draft next to an approved letter accepted' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when unique_violation then null;
 end;
end$$;
set role authenticated;
select pg_temp.as_user(1);
select public.change_sale_guarantee_status(pg_temp.oc('letter-2'),'sent');
select public.change_sale_guarantee_status(pg_temp.oc('letter-2'),'rejected');
-- Final statuses stay final, and after a rejection a new letter may be issued.
select pg_temp.expect_failure(format('select public.change_sale_guarantee_status(%L,%L)',pg_temp.oc('letter-2'),'accepted'),'Недопустимый переход');
insert into oc select 'letter-3',public.create_sale_guarantee_letter(pg_temp.oc('sale-letter'),'После отказа клиента');
select public.change_sale_guarantee_status(pg_temp.oc('letter-3'),'approved');
select public.change_sale_guarantee_status(pg_temp.oc('letter-3'),'sent');
select public.change_sale_guarantee_status(pg_temp.oc('letter-3'),'accepted');
select pg_temp.expect_failure(format('select public.change_sale_guarantee_status(%L,%L)',pg_temp.oc('letter-3'),'draft'),'Недопустимый переход');
-- The low line moves to a fresh batch: the accepted letter now covers nothing and is superseded; no letter is needed.
select public.rereserve_customer_order_item(pg_temp.oc('item-letter-low'),(select id from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000009'),'Нашлась свежая партия');
reset role;
do $$begin
 assert (select status='superseded' and superseded_reason='Партии заменены: Нашлась свежая партия' from public.guarantee_letters where id=pg_temp.oc('letter-3')),
  'a letter for a batch that is no longer reserved is superseded';
end$$;
set role authenticated;
select pg_temp.as_user(1);
select public.fulfill_customer_order(pg_temp.oc('sale-letter'));

-- 5. A shipment date that has already passed: batches are checked for today, not for that date.
insert into oc select 'sale-past',public.create_customer_order('c5100000-0000-4000-8000-000000000002',null,'c5200000-0000-4000-8000-000000000001',current_date+5,null,'Заказ с прошедшей датой');
insert into oc select 'item-past',public.add_customer_order_item(pg_temp.oc('sale-past'),'c5300000-0000-4000-8000-000000000005',10,'piece',null,null);
reset role;
update public.sales set sale_date=current_date-10,planned_shipment_date=current_date-3 where id=pg_temp.oc('sale-past');
set role authenticated;
select pg_temp.as_user(1);
select public.reserve_customer_order_item_fefo(pg_temp.oc('item-past'));
select pg_temp.expect_failure(format('select public.reserve_customer_order_item_override(%L,%L,%L)',pg_temp.oc('item-past'),
 (select id from public.inventory_balances where batch_id='c5400000-0000-4000-8000-000000000007'),'Старая партия'),'Партию нельзя резервировать на дату отгрузки');
select pg_temp.expect_failure(format('select public.reschedule_customer_order(%L,%L,%L)',pg_temp.oc('sale-past'),current_date-1,'Задним числом'),'не раньше сегодняшнего дня');
reset role;
do $$begin
 assert pg_temp.reserved_batches(pg_temp.oc('item-past'))='OR-PAST-2:10','the batch that expired yesterday is skipped';
 assert (select remaining_shelf_life_pct=50 from public.inventory_reservations where sale_item_id=pg_temp.oc('item-past') and status='active'),
  'and the shelf life is counted for today';
end$$;
set role authenticated;

-- 6. Reading and calling.
select pg_temp.as_user(4);
do $$begin
 assert not exists(select 1 from public.sale_revisions),'without sales.view the revisions are hidden';
end$$;
reset role;
do $$begin
 assert (select count(*)>=5 from public.sale_revisions where sale_id in (select id from oc where k like 'sale-%')),'revisions exist';
 assert not has_table_privilege('authenticated','public.sale_revisions','insert') and not has_table_privilege('authenticated','public.sale_revisions','update'),
  'revisions are written only by the functions';
 assert not has_function_privilege('anon','public.rereserve_customer_order_item(uuid,uuid,text)','execute')
  and not has_function_privilege('anon','public.reschedule_customer_order(uuid,date,text)','execute'),'anonymous callers are refused';
 assert not has_function_privilege('authenticated','private.reserve_sale_item_fefo(uuid)','execute')
  and not has_function_privilege('authenticated','private.sync_sale_guarantee_letters(uuid,text)','execute'),'the cores are internal';
end$$;

rollback;
