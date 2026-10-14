-- A confirmed order that can no longer ship tells its people, and its planned date can be moved (202609279000):
-- a blocked or quarantined batch is notified at once, an expired batch or a shelf life below the requirement when the
-- notifications are refreshed, each problem once; a confirmed order moves only to a date it can still ship on.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/order_fulfillment.sql

create function pg_temp.k(p text) returns uuid language sql stable as $$ select id from tests.fulfillment_context where k=p $$;
create function pg_temp.notes(p_sale text) returns bigint language sql stable as $$
 select count(*) from public.notifications where type='order_blocked' and entity_type='sale' and entity_id=pg_temp.k(p_sale)
   and recipient_user_id='ef000000-0000-4000-8000-000000000001' $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql; exception when others then
  if sqlerrm !~ p_pattern and sqlstate<>p_pattern then raise exception 'expected error matching %, got: % (%)',p_pattern,sqlerrm,sqlstate; end if;
  return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on function pg_temp.k(text),pg_temp.fails(text,text) to authenticated;

-- ---------- 1. a blocked or quarantined batch is notified at once, to the orders that reserve it ----------
set role authenticated;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false);
select public.set_inventory_batch_status('ef400000-0000-4000-8000-000000000001','blocked','Отзыв производителя');
reset role;
do $$ begin
 assert pg_temp.notes('sale')=1,'the order reserving the blocked batch is notified';
 assert pg_temp.notes('other')=0,'the order of another batch is not';
 assert (select title='Заказ '||(select sale_number from public.sales where id=pg_temp.k('sale'))||' нельзя отгрузить'
   and body ~ 'SYNTH-FF-P, партия SYNTH-EARLY: заблокирована — Отзыв производителя\. Верните заказ к подготовке'
   from public.notifications where type='order_blocked' and entity_id=pg_temp.k('sale')),'it names the batch and the reason';
end $$;
-- blocked → quarantine is not a new hold; released and held again later (another moment) is
update public.inventory_batches set status='quarantine' where id='ef400000-0000-4000-8000-000000000001';
do $$ begin assert pg_temp.notes('sale')=1,'no new notification while the batch stays on hold'; end $$;
update public.inventory_batches set status='available',status_reason=null where id='ef400000-0000-4000-8000-000000000001';
update public.inventory_batches set status='quarantine',status_reason='Проверка',status_changed_at=now()+interval '1 hour'
 where id='ef400000-0000-4000-8000-000000000001';
do $$ begin assert pg_temp.notes('sale')=2,'held again: notified again'; end $$;
update public.inventory_batches set status='available',status_reason=null where id='ef400000-0000-4000-8000-000000000001';

-- ---------- 2. what time brings, when the notifications are refreshed; each problem once ----------
update public.inventory_batches set manufacture_date=current_date-500,expiry_date=current_date-1 where id='ef400000-0000-4000-8000-000000000002';
set role authenticated;
select public.refresh_my_order_notifications();
select public.refresh_my_order_notifications();
reset role;
do $$ begin
 assert pg_temp.notes('other')=1,'the expired batch of the other order is notified once';
 assert pg_temp.notes('sale')=3,'and the order with both batches too';
 assert exists(select 1 from public.notifications where entity_id=pg_temp.k('other') and body ~ 'партия SYNTH-LATE: просрочена'),'the expired batch named';
end $$;
update public.inventory_batches set manufacture_date='2098-11-01',expiry_date='2099-12-06' where id='ef400000-0000-4000-8000-000000000002';
update public.guarantee_letters set status='cancelled' where id=pg_temp.k('letter');
set role authenticated;
select public.refresh_my_order_notifications();
reset role;
do $$ begin
 assert pg_temp.notes('sale')=4,'the shelf life below the requirement without a letter is notified';
 assert exists(select 1 from public.notifications where entity_id=pg_temp.k('sale') and body ~ 'нужно действующее гарантийное письмо'),'it says why';
end $$;
update public.guarantee_letters set status='approved' where id=pg_temp.k('letter');

-- ---------- 3. only for those who see orders ----------
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000001',id,'deny','Notification test','ef000000-0000-4000-8000-000000000001' from public.permissions where code='sales.view';
update public.inventory_batches set status='blocked',status_reason='Без доступа',status_changed_at=now()+interval '2 hours'
 where id='ef400000-0000-4000-8000-000000000002';
set role authenticated;
select pg_temp.fails($$select public.refresh_my_order_notifications()$$,'42501');
reset role;
do $$ begin assert pg_temp.notes('other')=1,'no notification to an employee without sales.view'; end $$;
update public.inventory_batches set status='available',status_reason=null where id='ef400000-0000-4000-8000-000000000002';
delete from public.user_permission_overrides where user_id='ef000000-0000-4000-8000-000000000001';

-- ---------- 4. rescheduling ----------
set role authenticated;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false);
-- the other order still ships on 1 March 2099 (its batch lasts, 70 % shelf life ≥ 60 %)
select public.reschedule_customer_order(pg_temp.k('other'),'2099-03-01','Клиент перенёс приёмку');
-- but not after its batch expires
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('other'),'2099-12-10','Поздно')$$,
 'С новой датой заказ нельзя отгрузить: SYNTH-FF-P, партия SYNTH-LATE: истечёт до отгрузки');
-- the order covered by a letter cannot move later than the letter's shelf life
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('sale'),'2099-03-01','Позже')$$,
 'партия SYNTH-EARLY: остаточный срок .* нужно действующее гарантийное письмо.*Верните заказ к подготовке');
-- but it can move earlier
select public.reschedule_customer_order(pg_temp.k('sale'),'2099-01-10','Клиент готов раньше');
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('sale'),'2099-01-10','Та же')$$,'не изменилась');
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('sale'),current_date-1,'Вчера')$$,'в прошлом');
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('sale'),'2099-01-11','  ')$$,'причину');
-- a reserved order moves without the shipment check: confirmation checks it again
select public.return_customer_order_to_preparation(pg_temp.k('other'),'Перенос далеко');
select public.reschedule_customer_order(pg_temp.k('other'),'2099-12-10','Ждём новую партию');
reset role;
do $$ begin
 assert (select planned_shipment_date='2099-01-10' from public.sales where id=pg_temp.k('sale')),'the order moved earlier';
 assert (select planned_shipment_date='2099-12-10' from public.sales where id=pg_temp.k('other')),'the reserved order moved';
 assert (select count(*)=3 from public.sale_shipment_date_changes),'three moves recorded';
 assert (select previous_date='2099-01-20' and new_date='2099-03-01' and reason='Клиент перенёс приёмку'
   and changed_by='ef000000-0000-4000-8000-000000000001' from public.sale_shipment_date_changes
   where sale_id=pg_temp.k('other') order by changed_at,new_date limit 1),'with the previous date, the reason and the employee';
 assert (select count(*)=0 from public.sale_shipment_date_changes c join public.sales s on s.id=c.sale_id where s.planned_shipment_date='2099-01-20'),
  'failed attempts leave nothing';
end $$;
-- the moved confirmed order still ships; a shipped order cannot move
set role authenticated;
select public.fulfill_customer_order(pg_temp.k('sale'));
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('sale'),'2099-01-12','После отгрузки')$$,'неотгруженный');
do $$ begin
 perform 1 from public.sale_shipment_date_changes;
 begin
  insert into public.sale_shipment_date_changes(sale_id,previous_date,new_date,reason) values(pg_temp.k('sale'),'2099-01-01','2099-01-02','Подделка');
  raise exception 'a direct insert was allowed' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when insufficient_privilege then null;
 end;
end $$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000001',id,'deny','Reschedule test','ef000000-0000-4000-8000-000000000001' from public.permissions where code='sales.manage';
set role authenticated;
select pg_temp.fails($$select public.reschedule_customer_order(pg_temp.k('other'),'2099-12-11','Без права')$$,'42501');
reset role;

rollback;
\echo 'order_blocker_notifications: all checks passed'
