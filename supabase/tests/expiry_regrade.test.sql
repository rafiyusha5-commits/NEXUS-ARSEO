-- 202611280800: regrade by expiry after the receipt. Part of a batch moves to the batch of the same product and number
-- with the right expiry: a new batch takes the cost, origin and state of the source; an existing one is reused; only free
-- stock moves; a place under a count stays locked; two adjustments, the audit log, a reversal while the stock is still
-- free; not a loss. Synthetic data; rolled back.
\set ON_ERROR_STOP 1
begin;
set local timezone='UTC';
do $$begin assert current_date<date '2099-01-01','Explicitly revise fixed fixture dates';end$$;
\ir fixtures/order_fulfillment.sql
-- SYNTH-EARLY: 100 on hand, all reserved by the order; SYNTH-LATE (made 2098-11-01, until 2099-12-06): 200 on hand,
-- 100 reserved by the two orders. The cost of SYNTH-LATE: 12.5 EUR a piece.
update public.inventory_batches set unit_landed_cost=12.5,cost_currency_id=(select id from public.currencies where code='EUR'),cost_uom='piece',cost_basis='receipts'
 where id='ef400000-0000-4000-8000-000000000002';
insert into auth.users(id,email,raw_user_meta_data) values ('ef000000-0000-4000-8000-000000000009','regrade-none@example.invalid','{"full_name":"Without control"}');
insert into public.user_roles(user_id,role_id) select 'ef000000-0000-4000-8000-000000000009',id from public.app_roles where code='director';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ef000000-0000-4000-8000-000000000009',id,'deny','regrade test','ef000000-0000-4000-8000-000000000001' from public.permissions where code='inventory.control';
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.on_hand(p_expiry date) returns numeric language sql stable security definer as $$
 select coalesce(sum(bl.quantity_on_hand),0) from public.inventory_balances bl join public.inventory_batches b on b.id=bl.batch_id
  where b.product_id='ef300000-0000-4000-8000-000000000001' and b.batch_number='SYNTH-LATE' and b.expiry_date=p_expiry $$;
create function pg_temp.losses() returns text language sql stable as $$select public.loss_report('reason',current_date,current_date)->'totals'->>'lines'$$;
grant execute on all functions in schema pg_temp to authenticated;
create temporary table regrade_ctx(k text primary key,id uuid);
grant all on regrade_ctx to authenticated;

select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into regrade_ctx values ('losses_before',null);
do $$begin perform set_config('tests.losses',coalesce(pg_temp.losses(),'0'),true);end $$;

-- 1. Without the right, and every rule of the operation.
reset role;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000009',true);
set local role authenticated;
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1,'2099-06-30','Пересорт')$q$,'Остатки: контроль');
reset role;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000001',1,'2099-03-31','Пересорт')$q$,'только свободный остаток: свободно 0');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',101,'2099-06-30','Пересорт')$q$,'свободно 100');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1,'2099-12-06','Пересорт')$q$,'совпадает с текущим');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1,null,'Пересорт')$q$,'правильный срок');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1,'2098-10-31','Пересорт')$q$,'раньше даты производства');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1,'2099-06-30',' ')$q$,'причину');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',0,'2099-06-30','Пересорт')$q$,'положительное');
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1.0001,'2099-06-30','Пересорт')$q$,'трёх знаков');
select pg_temp.fails($q$select public.regrade_batch_expiry(gen_random_uuid(),1,'2099-06-30','Пересорт')$q$,'Остаток не найден');

-- 2. 30 of SYNTH-LATE are found to expire on 2099-06-30: a new batch, with the cost and origin of the source.
insert into regrade_ctx values ('r1',public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',30,'2099-06-30','На 3 коробках срок 30.06.2099'));
reset role;
do $$
declare t public.inventory_batches; s public.inventory_batches; r public.expiry_regrades;
begin
 select * into r from public.expiry_regrades where id=(select id from regrade_ctx where k='r1');
 select * into s from public.inventory_batches where id='ef400000-0000-4000-8000-000000000002';
 select * into t from public.inventory_batches where product_id=s.product_id and batch_number='SYNTH-LATE' and expiry_date='2099-06-30';
 assert r.regrade_number ~ '^ПСР-\d{6}$' and r.new_batch and r.to_batch_id=t.id and r.quantity=30 and r.status='posted';
 assert t.status='available' and t.unit_landed_cost=12.5 and t.cost_uom='piece' and t.cost_basis='receipts'
   and t.source_shipment_item_id is not distinct from s.source_shipment_item_id and t.manufacture_date=s.manufacture_date,
   'the new batch keeps the cost and origin of the source';
 assert pg_temp.on_hand('2099-12-06')=170 and pg_temp.on_hand('2099-06-30')=30;
 assert (select quantity_reserved from public.inventory_balances where id='ef500000-0000-4000-8000-000000000002')=100,'the reservations stay';
 assert (select count(*) from public.inventory_movements where expiry_regrade_id=r.id and movement_type='adjustment')=2;
 assert (select count(*) from public.inventory_movements where expiry_regrade_id=r.id and batch_id=s.id and from_warehouse_id is not null and quantity=30)=1;
 assert (select count(*) from public.inventory_movements where expiry_regrade_id=r.id and batch_id=t.id and to_warehouse_id is not null and quantity=30)=1;
 assert exists (select 1 from public.audit_log where action='expiry_regrade' and metadata->>'regrade'=r.regrade_number and (after_data->>'new_batch')::boolean);
end $$;
-- 3. Ten more to the same expiry: the batch is reused.
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into regrade_ctx values ('r2',public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',10,'2099-06-30','Ещё коробка'));
reset role;
do $$begin
 assert not (select new_batch from public.expiry_regrades where id=(select id from regrade_ctx where k='r2'));
 assert pg_temp.on_hand('2099-12-06')=160 and pg_temp.on_hand('2099-06-30')=40;
end $$;
-- 4. A blocked source: the part moved stays blocked, with the reason, until someone checks it.
update public.inventory_batches set status='blocked',status_reason='Пересорт по срокам: проверка',status_changed_at=now() where id='ef400000-0000-4000-8000-000000000002';
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',5,'2099-03-31','Ещё один срок');
reset role;
do $$begin
 assert (select status='blocked' and status_reason='Пересорт по срокам: проверка' from public.inventory_batches
          where batch_number='SYNTH-LATE' and expiry_date='2099-03-31'),'a blocked part is not released by a regrade';
end $$;
update public.inventory_batches set status='available',status_reason=null where id='ef400000-0000-4000-8000-000000000002';

-- 5. A place under an inventory count is locked.
savepoint counted;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v_count uuid := public.create_inventory_count('ef200000-0000-4000-8000-000000000001','partial',true,null,null);
begin
 perform public.set_inventory_count_scope(v_count,null,null,true,null);
 perform public.start_inventory_count(v_count);
end $$;
select pg_temp.fails($q$select public.regrade_batch_expiry('ef500000-0000-4000-8000-000000000002',1,'2099-06-30','Во время пересчёта')$q$,'Идёт инвентаризация');
reset role;
rollback to counted;

-- 6. Not a loss; the history of the batch; the reversal while the moved stock is free, once.
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare h jsonb := public.batch_expiry_regrades('ef400000-0000-4000-8000-000000000002');
begin
 assert coalesce(pg_temp.losses(),'0')=current_setting('tests.losses'),'a regrade is not a loss';
 assert (h->>'can_regrade')::boolean and jsonb_array_length(h->'regrades')=3 and h->'regrades'->0->>'direction'='out'
   and h->'regrades'->-1->>'reason'='На 3 коробках срок 30.06.2099' and (h->'regrades'->-1->>'from_expiry')::date='2099-12-06';
end $$;
savepoint consumed;
reset role;
update public.inventory_balances set quantity_reserved=quantity_on_hand
 where id=(select to_balance_id from public.expiry_regrades where id=(select id from regrade_ctx where k='r1'));
set local role authenticated;
select pg_temp.fails($q$select public.cancel_expiry_regrade((select id from regrade_ctx where k='r1'),'Ошиблись')$q$,'свободно 0');
reset role;
rollback to consumed;
set local role authenticated;
select pg_temp.fails($q$select public.cancel_expiry_regrade((select id from regrade_ctx where k='r1'),' ')$q$,'причину отмены');
select public.cancel_expiry_regrade((select id from regrade_ctx where k='r1'),'Ошиблись коробкой');
select pg_temp.fails($q$select public.cancel_expiry_regrade((select id from regrade_ctx where k='r1'),'Ещё раз')$q$,'уже отменён');
reset role;
do $$begin
 assert pg_temp.on_hand('2099-12-06')=185 and pg_temp.on_hand('2099-06-30')=10;
 assert (select count(*) from public.inventory_movements where expiry_regrade_id=(select id from regrade_ctx where k='r1') and is_reversal)=2;
 assert (select status='cancelled' and cancel_reason='Ошиблись коробкой' from public.expiry_regrades where id=(select id from regrade_ctx where k='r1'));
 assert exists (select 1 from public.audit_log where action='expiry_regrade_cancelled');
 assert not has_table_privilege('authenticated','public.expiry_regrades','select');
 assert not has_function_privilege('anon','public.regrade_batch_expiry(uuid,numeric,date,text)','execute');
end $$;
rollback;
