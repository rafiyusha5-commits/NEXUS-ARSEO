-- 202611170400: payables with partial payments, due dates, register, compatibility with paid expenses and costing.
-- Synthetic data only. Hand calculations next to every check. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('d4000000-0000-4000-8000-000000000001','payables-director@example.invalid','{"full_name":"Payables director"}'),
 ('d4000000-0000-4000-8000-000000000002','payables-accountant@example.invalid','{"full_name":"Accountant without purchase prices"}'),
 ('d4000000-0000-4000-8000-000000000003','payables-logistics@example.invalid','{"full_name":"Logistics without finance"}'),
 ('d4000000-0000-4000-8000-000000000004','payables-old-payer@example.invalid','{"full_name":"Former payer"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('d4000000-0000-4000-8000-000000000001'::uuid,'director'),
 ('d4000000-0000-4000-8000-000000000002'::uuid,'accountant'),
 ('d4000000-0000-4000-8000-000000000003'::uuid,'logistics_specialist'),
 ('d4000000-0000-4000-8000-000000000004'::uuid,'accountant')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'd4000000-0000-4000-8000-000000000002',id,'deny','No purchase prices','d4000000-0000-4000-8000-000000000001'
 from public.permissions where code='prices.purchase.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('d4100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Payables supplier','FI','D4-SUP'),
 ('d4100000-0000-4000-8000-000000000002',array['carrier'],'Payables carrier','KZ','D4-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('d4200000-0000-4000-8000-000000000001','D4-A','{"ru":"Товар кредиторки"}','d4100000-0000-4000-8000-000000000001','active');

create temporary table d4(k text primary key,id uuid);
grant all on d4 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from d4 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.e(p_key text) returns public.expenses language sql stable security definer as $$ select * from public.expenses where id=(select id from d4 where k=p_key) $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.pay(p_key text,p_amount numeric,p_date date default current_date) returns uuid language sql as $$
 select public.record_expense_payment(gen_random_uuid(),pg_temp.id(p_key),p_amount,p_date,null,'Платёжное поручение') $$;
grant execute on all functions in schema pg_temp to authenticated;

-- A received shipment with expenses: goods 1000 EUR (supplier), freight 300 EUR and 90000 KZT (carrier), extra 50 EUR.
select set_config('request.jwt.claim.sub','d4000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v_ship uuid;v_t uuid;v_i uuid;
begin
 v_ship:=public.create_shipment_with_stages('D4-SHIP','import','d4100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),auth.uid(),current_date,current_date+14);
 perform public.add_shipment_transport(v_ship,null,null,null,null);
 select id into v_t from public.shipment_transports where shipment_id=v_ship;
 v_i:=public.allocate_shipment_item(public.create_shipment_item(v_ship,'d4200000-0000-4000-8000-000000000001','piece',100,10,pg_temp.cur('EUR')),v_t,100);
 perform public.change_shipment_transport_status(v_t,'arrived');
 perform public.receive_shipment_transport(v_t,null,jsonb_build_array(jsonb_build_object('item_id',v_i,'accepted_quantity',100,'batch_number','D4-LOT','expiry_date',(current_date+200)::text)),'Кладовщик',null);
 -- A second shipment carries the KZT freight (no cost calculation there).
 insert into d4 values('ship2',public.create_shipment_with_stages('D4-SHIP2','import','d4100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),auth.uid(),current_date,current_date+14));
 insert into d4 values('ship',v_ship),
  ('goods',public.create_expense(v_ship,'goods_cost','d4100000-0000-4000-8000-000000000001',1000,pg_temp.cur('EUR'),current_date-20,false,null,'Товар')),
  ('freight',public.create_expense(v_ship,'transport','d4100000-0000-4000-8000-000000000002',300,pg_temp.cur('EUR'),current_date-20,false,null,'Перевозка')),
  ('freight_kzt',public.create_expense(pg_temp.id('ship2'),'transport','d4100000-0000-4000-8000-000000000002',90000,pg_temp.cur('KZT'),current_date-20,false,null,'Перевозка по РК')),
  ('extra',public.create_expense(v_ship,'logistics','d4100000-0000-4000-8000-000000000002',50,pg_temp.cur('EUR'),current_date-20,false,null,'Склад')),
  ('old',public.create_expense(v_ship,'broker_fee','d4100000-0000-4000-8000-000000000002',40,pg_temp.cur('EUR'),current_date-40,false,null,'Брокер'));
 perform public.confirm_expense(pg_temp.id(k)) from unnest(array['goods','freight','freight_kzt','extra','old']) k;
 perform public.allocate_expense(pg_temp.id(k),'by_quantity',pg_temp.cur('EUR')) from unnest(array['goods','freight','old']) k;
end $$;
reset role;

-- 1. A payment made before this migration: one payment with the same amount, date and author after the backfill.
update public.expenses set status='paid',paid_by='d4000000-0000-4000-8000-000000000004',paid_at='2026-11-01 09:00+05'
 where id=pg_temp.id('old');
do $$begin
 assert private.backfill_legacy_payments()=1 and private.backfill_legacy_payments()=0,'once per paid expense';
 assert (select count(*)=1 and bool_and(p.amount=40 and p.paid_on='2026-11-01' and p.created_by='d4000000-0000-4000-8000-000000000004'
   and p.created_at='2026-11-01 09:00+05' and p.legacy and a.amount=40)
   from public.payment_applications a join public.payments p on p.id=a.payment_id where a.expense_id=pg_temp.id('old')),
   'same amount, date and author';
end $$;

select set_config('request.jwt.claim.sub','d4000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select pg_temp.fails($q$select pg_temp.pay('extra',0)$q$,'больше нуля');
select pg_temp.fails($q$select pg_temp.pay('extra',1.005)$q$,'до копеек');
select pg_temp.fails($q$select pg_temp.pay('extra',1,current_date+1)$q$,'в будущем');
-- The same request twice is one payment.
select public.record_expense_payment('d4500000-0000-4000-8000-000000000001',pg_temp.id('extra'),10,current_date,null,null);
select public.record_expense_payment('d4500000-0000-4000-8000-000000000001',pg_temp.id('extra'),10,current_date,null,null);
-- 4. A confirmed (not allocated) expense paid in full stays confirmed; allocation then makes it paid.
select pg_temp.pay('extra',40);
do $$begin assert (pg_temp.e('extra')).status='confirmed','not allocated yet';end $$;
select public.allocate_expense(pg_temp.id('extra'),'by_quantity',pg_temp.cur('EUR'));
do $$begin assert (pg_temp.e('extra')).status='paid' and (pg_temp.e('extra')).paid_at is not null,'allocation of a fully paid expense -> paid';end $$;
-- 2. Cost before payments (a draft calculation), to compare after the payments.
insert into d4 values('calc_before',public.calculate_shipment_cost(pg_temp.id('ship'),pg_temp.cur('EUR')));
-- 3. Partial payments of the 300 EUR freight: 100 + 150, then 60 is refused (50 left), then 50 closes it.
select pg_temp.pay('freight',100,current_date-5);
select pg_temp.pay('freight',150);
select pg_temp.fails($q$select pg_temp.pay('freight',60)$q$,'превышает сумму расхода: осталось оплатить 50');
do $$begin assert (pg_temp.e('freight')).status='allocated' and (pg_temp.e('freight')).paid_at is null,'partly paid stays allocated';end $$;
select pg_temp.pay('freight',50);
do $$begin
 assert (pg_temp.e('freight')).status='paid' and (pg_temp.e('freight')).paid_by='d4000000-0000-4000-8000-000000000001','paid in full -> paid';
end $$;
select pg_temp.fails($q$select pg_temp.pay('freight',1)$q$,'только подтверждённый фактический');
-- 5. "Pay the rest at once" (former action and the assistant): goods 1000, 400 paid, mark_expense_paid adds 600.
select pg_temp.pay('goods',400);
select public.mark_expense_paid(pg_temp.id('goods'));
-- 6. The cost does not depend on payments: same totals and inputs as before.
insert into d4 values('calc_after',public.calculate_shipment_cost(pg_temp.id('ship'),pg_temp.cur('EUR')));
reset role;
do $$begin
 assert (pg_temp.e('goods')).status='paid' and private.expense_paid_amount(pg_temp.id('goods'))=1000;
 assert (select count(*) from public.payment_applications where expense_id=pg_temp.id('goods'))=2;
 assert (select a.goods_total=b.goods_total and a.expenses_total=b.expenses_total and a.inputs_digest=b.inputs_digest
   from public.cost_calculations a,public.cost_calculations b where a.id=pg_temp.id('calc_before') and b.id=pg_temp.id('calc_after')),
   'cost calculation identical before and after payments';
end $$;

-- 7. A partly paid expense: no cancellation, reversal with a reason keeps its payments.
set local role authenticated;
select pg_temp.pay('freight_kzt',30000);
select pg_temp.fails($q$select public.cancel_expense(pg_temp.id('freight_kzt'),'Ошибка')$q$,'частично оплачен');
select public.set_expense_due_date(pg_temp.id('freight_kzt'),current_date-3);
reset role;

-- 8. Register. Carrier, EUR: freight 300 + extra 50 + old 40 = 390 accrued, 390 paid. KZT: 90000 accrued, 30000 paid,
--    60000 rest, overdue 3 days. Supplier, EUR: goods 1000/1000. Accrued - paid = rest everywhere.
set local role authenticated;
do $$
declare s jsonb;r jsonb;
begin
 s:=public.payables_summary();
 assert (select bool_and((x->>'accrued')::numeric-(x->>'paid')::numeric=(x->>'rest')::numeric) from jsonb_array_elements(s) x),'register adds up';
 select x into r from jsonb_array_elements(s) x where x->>'payee'='Payables carrier' and x->>'currency'='KZT';
 assert r->>'accrued'='90000.00' and r->>'paid'='30000.00' and r->>'rest'='60000.00' and (r->>'overdue_days')::int=3 and r->>'overdue_amount'='60000.00';
 select x into r from jsonb_array_elements(s) x where x->>'payee'='Payables carrier' and x->>'currency'='EUR';
 assert r->>'accrued'='390.00' and r->>'rest'='0.00' and r->'overdue_days'='null'::jsonb,'currencies are never added together';
 select x into r from jsonb_array_elements(s) x where x->>'payee'='Payables supplier';
 assert r->>'accrued'='1000.00' and r->>'paid'='1000.00';
 r:=public.payables_payee('d4100000-0000-4000-8000-000000000002');
 assert (select jsonb_array_length(x->'payments')=3 and x->>'rest'='0.00' from jsonb_array_elements(r->'expenses') x where x->>'id'=pg_temp.id('freight')::text),
   'carrier card: the expense with its three payments';
 assert (select x->'payments'->0->>'author'='Payables director' and x->'payments'->0->>'note'='Платёжное поручение'
   from jsonb_array_elements(r->'expenses') x where x->>'id'=pg_temp.id('freight')::text);
end $$;
reset role;
-- No due date: "срок не задан", not overdue. Reversal of the partly paid KZT freight takes it out of the debt; since
-- 202611210200 what was paid against it stays in the register as the carrier's overpayment.
do $$begin
 assert (select (x->>'no_due_date')::int=0 from jsonb_array_elements(public.payables_summary()) x where x->>'currency'='KZT');
end $$;
select set_config('request.jwt.claim.sub','d4000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.set_expense_due_date(pg_temp.id('freight_kzt'),null);
do $$begin
 assert (select (x->>'no_due_date')::int=1 and x->'overdue_days'='null'::jsonb from jsonb_array_elements(public.payables_summary()) x where x->>'currency'='KZT'),
   'without a due date: counted as "срок не задан", not overdue';
end $$;
select public.reverse_expense(pg_temp.id('freight_kzt'),'Перевозчик выставил неверный счёт');
do $$begin
 assert (select (x->>'accrued')::numeric=0 and (x->>'rest')::numeric=0 and (x->>'overpaid')::numeric=30000
           from jsonb_array_elements(public.payables_summary()) x where x->>'currency'='KZT'),
   'reversed: no debt any more; the 30 000 paid against it is the overpayment';
end $$;
reset role;
do $$begin
 assert (pg_temp.e('freight_kzt')).status='reversed' and private.expense_paid_amount(pg_temp.id('freight_kzt'))=30000,'payments stay in history';
end $$;

-- 9. Without purchase prices goods cost is in neither rows nor totals; without finance.pay no payment.
select set_config('request.jwt.claim.sub','d4000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$begin
 assert not exists(select 1 from jsonb_array_elements(public.payables_summary()) x where x->>'payee'='Payables supplier'),'goods cost hidden in totals';
 assert jsonb_array_length(public.payables_payee('d4100000-0000-4000-8000-000000000001')->'expenses')=0,'goods cost hidden in the card';
 assert not exists(select 1 from jsonb_array_elements(public.payables_summary()) x where x->>'payee' like 'Payables%' and '1000.00' in (x->>'accrued',x->>'paid',x->>'rest')),'no goods amount anywhere';
end $$;
select pg_temp.fails($q$select pg_temp.pay('goods',1)$q$,'Нет доступа к стоимости товара');
reset role;
select set_config('request.jwt.claim.sub','d4000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.payables_summary()$q$,'Нет доступа к кредиторке');
select pg_temp.fails($q$select pg_temp.pay('extra',1)$q$,'Нет права подтверждать оплату');
select pg_temp.fails($q$select * from public.payments$q$,'permission denied');
reset role;

-- 10. History cannot be edited, even by the owner; a direct overpayment is refused by the database.
select pg_temp.fails($q$update public.payments set amount=1$q$,'неизменяема');
select pg_temp.fails($q$delete from public.payment_applications$q$,'неизменяема');
select pg_temp.fails($q$insert into public.payment_applications(payment_id,expense_id,amount,created_by)
 select id,pg_temp.id('goods'),1,created_by from public.payments where legacy limit 1$q$,'превышает|только подтверждённый|другому получателю|распределена');
do $$begin
 assert not has_function_privilege('anon','public.record_expense_payment(uuid,uuid,numeric,date,uuid,text)','execute');
 assert not has_function_privilege('authenticated','private.backfill_legacy_payments()','execute');
end $$;
rollback;
\echo payables: all checks passed
