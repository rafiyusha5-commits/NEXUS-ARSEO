-- 202611280200: payment calendar. Two currencies, an advance (part set off), a goods advance, an overpayment of a reversed
-- expense with a partial refund, partial payments, an order not shipped yet, planned expenses, an expense without a due
-- date, overdue debts both ways; reconciliation with the payables and receivables registers; rights; the daily cash gap
-- notification. Synthetic data only; hand calculations next to every check. Everything is rolled back.
-- T = today, W = Monday of this week. Past dates are counted from W so that the plan-fact weeks do not depend on the day.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ca000000-0000-4000-8000-000000000001','cash-director@example.invalid','{"full_name":"Cash director"}'),
 ('ca000000-0000-4000-8000-000000000002','cash-accountant@example.invalid','{"full_name":"Accountant without purchase prices"}'),
 ('ca000000-0000-4000-8000-000000000003','cash-logistics@example.invalid','{"full_name":"Logistics without finance"}'),
 ('ca000000-0000-4000-8000-000000000004','cash-payables@example.invalid','{"full_name":"Accountant without receivables"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ca000000-0000-4000-8000-000000000001'::uuid,'director'),
 ('ca000000-0000-4000-8000-000000000002'::uuid,'accountant'),
 ('ca000000-0000-4000-8000-000000000003'::uuid,'logistics_specialist'),
 ('ca000000-0000-4000-8000-000000000004'::uuid,'accountant')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select v.u::uuid,p.id,'deny','cash calendar test','ca000000-0000-4000-8000-000000000001'
   from (values ('ca000000-0000-4000-8000-000000000002','prices.purchase.view'),
                ('ca000000-0000-4000-8000-000000000004','receivables.view')) v(u,code)
   join public.permissions p on p.code=v.code;
insert into public.counterparties(id,roles,legal_name,short_name,country,tax_id) values
 ('ca100000-0000-4000-8000-000000000001',array['customer'],'ТОО «Клиент один»','Клиент один','KZ','CA-C1'),
 ('ca100000-0000-4000-8000-000000000002',array['customer'],'ТОО «Должник»','Должник','KZ','CA-C2'),
 ('ca100000-0000-4000-8000-000000000003',array['customer'],'Euro customer','Euro customer','DE','CA-C3'),
 ('ca100000-0000-4000-8000-000000000004',array['customer'],'ТОО «Переплатил»','Переплатил','KZ','CA-C4'),
 ('ca100000-0000-4000-8000-000000000005',array['carrier'],'Cash carrier','Перевозчик','KZ','CA-P1'),
 ('ca100000-0000-4000-8000-000000000006',array['manufacturer','supplier'],'Cash supplier','Поставщик','FI','CA-P2');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ca200000-0000-4000-8000-000000000001','CA-A','{"ru":"Товар календаря"}','ca100000-0000-4000-8000-000000000006','active');

create temporary table ca(k text primary key,id uuid);
grant all on ca to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from ca where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.w() returns date language sql stable as $$ select date_trunc('week', current_date)::date $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
-- One currency of a calendar; one period of it (0 = the first); a number of a currency.
create function pg_temp.c(p_cal jsonb,p_code text) returns jsonb language sql immutable as $$
 select e from jsonb_array_elements(p_cal->'currencies') e where e->>'currency'=p_code $$;
create function pg_temp.p(p_cal jsonb,p_code text,p_n integer) returns jsonb language sql immutable as $$
 select pg_temp.c(p_cal,p_code)->'periods'->p_n $$;
create function pg_temp.n(p_cal jsonb,p_code text,p_key text) returns numeric language sql immutable as $$
 select (pg_temp.c(p_cal,p_code)->>p_key)::numeric $$;
-- Sum of a flow over every period of a currency.
create function pg_temp.total(p_cal jsonb,p_code text,p_key text) returns numeric language sql immutable as $$
 select coalesce(sum((x->>p_key)::numeric),0) from jsonb_array_elements(pg_temp.c(p_cal,p_code)->'periods') x $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Receivables. C1: 500 000 KZT due T+10, paid 200 000 on W-3 -> 300 000 open, not due. C2: 150 000 due W-20 and an
-- adjustment of 50 000 on W-4 (due that day) -> 200 000 overdue. C3: 3 000 EUR due T+100, beyond every horizon. C4: 100 000
-- due W-10, paid 130 000 on W-2 -> nothing open; its 30 000 credit is never money in.
insert into public.customer_opening_balances(customer_id,currency_id,as_of,amount,due_date,imported_by) values
 ('ca100000-0000-4000-8000-000000000001',pg_temp.cur('KZT'),current_date-30,500000,current_date+10,'ca000000-0000-4000-8000-000000000001'),
 ('ca100000-0000-4000-8000-000000000002',pg_temp.cur('KZT'),pg_temp.w()-30,150000,pg_temp.w()-20,'ca000000-0000-4000-8000-000000000001'),
 ('ca100000-0000-4000-8000-000000000003',pg_temp.cur('EUR'),current_date-10,3000,current_date+100,'ca000000-0000-4000-8000-000000000001'),
 ('ca100000-0000-4000-8000-000000000004',pg_temp.cur('KZT'),pg_temp.w()-30,100000,pg_temp.w()-10,'ca000000-0000-4000-8000-000000000001');
insert into public.customer_balance_adjustments(customer_id,currency_id,entry_date,amount,reason,created_by) values
 ('ca100000-0000-4000-8000-000000000002',pg_temp.cur('KZT'),pg_temp.w()-4,50000,'Доначисление','ca000000-0000-4000-8000-000000000001');
insert into public.customer_credit_terms(customer_id,default_deferral_days,updated_by) values
 ('ca100000-0000-4000-8000-000000000001',14,'ca000000-0000-4000-8000-000000000001');
insert into public.bank_statement_imports(id,file_name,file_sha256,currency_id,imported_by) values
 ('ca300000-0000-4000-8000-000000000001','cash.txt',repeat('c',64),pg_temp.cur('KZT'),'ca000000-0000-4000-8000-000000000001');
insert into public.bank_statement_lines(import_id,line_key,doc_number,doc_date,amount,currency_id,status,customer_id,matched_how) values
 ('ca300000-0000-4000-8000-000000000001','CA-1','1',pg_temp.w()-3,200000,pg_temp.cur('KZT'),'matched','ca100000-0000-4000-8000-000000000001','auto_bin'),
 ('ca300000-0000-4000-8000-000000000001','CA-2','2',pg_temp.w()-2,130000,pg_temp.cur('KZT'),'matched','ca100000-0000-4000-8000-000000000004','auto_bin');

-- Orders not shipped yet. S1 (C1, confirmed): ships T+7, 14 days of deferral -> T+21; 10 x 1 000 = 10 000 KZT and a line
-- without a price. S3 (C3, reserved): ships T+1, no deferral -> T+1; 2 x 100 = 200 EUR. S2 (draft) is not money.
insert into public.sales(id,sale_number,customer_id,warehouse_id,sale_date,planned_shipment_date,currency_id,status,created_by)
select v.id::uuid,v.n,v.c::uuid,(select id from public.warehouses where status='active' and not is_virtual order by code limit 1),
       current_date,current_date+v.d,pg_temp.cur(v.cur),v.s,'ca000000-0000-4000-8000-000000000001'
  from (values ('ca400000-0000-4000-8000-000000000001','CA-S1','ca100000-0000-4000-8000-000000000001',7,'KZT','confirmed'),
               ('ca400000-0000-4000-8000-000000000002','CA-S2','ca100000-0000-4000-8000-000000000001',3,'KZT','draft'),
               ('ca400000-0000-4000-8000-000000000003','CA-S3','ca100000-0000-4000-8000-000000000003',1,'EUR','reserved')) v(id,n,c,d,cur,s);
insert into public.sale_items(sale_id,product_id,quantity,uom,unit_price) values
 ('ca400000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000001',10,'piece',1000),
 ('ca400000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000001',1,'box',null),
 ('ca400000-0000-4000-8000-000000000002','ca200000-0000-4000-8000-000000000001',5,'piece',1000),
 ('ca400000-0000-4000-8000-000000000003','ca200000-0000-4000-8000-000000000001',2,'piece',100);

-- Expenses (all of customer C1, no shipment). KZT to the carrier: E1 transport 400 000 due T+3, E2 logistics 1 200 000 due
-- T+5, E3 transport 50 000 due T-7, E4 other 70 000 without a due date, E7 tax 60 000 due T-15 (paid, then reversed), E8 a
-- draft. EUR: E5 goods 5 000 to the supplier due T+14, E6 transport 800 to the carrier due T+2. Planned: PL1 broker 120 000
-- KZT on T+20 (no actual broker expense: counted), PL2 transport 30 000 KZT on T+8 (actual transport exists: not counted).
with e as (
  insert into public.expenses(attributed_customer_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,due_date,
                              is_planned,status,confirmed_by,confirmed_at,created_by,notes)
  select 'ca100000-0000-4000-8000-000000000001',v.t,v.p::uuid,v.a,pg_temp.cur(v.cur),current_date+v.inc,current_date+v.due,
         v.planned,v.s,case when v.s='confirmed' then 'ca000000-0000-4000-8000-000000000001'::uuid end,
         case when v.s='confirmed' then now() end,'ca000000-0000-4000-8000-000000000001',v.k
    from (values ('E1','transport','ca100000-0000-4000-8000-000000000005',400000,'KZT',-30,3,false,'confirmed'),
                 ('E2','logistics','ca100000-0000-4000-8000-000000000005',1200000,'KZT',-30,5,false,'confirmed'),
                 ('E3','transport','ca100000-0000-4000-8000-000000000005',50000,'KZT',-30,-7,false,'confirmed'),
                 ('E4','other','ca100000-0000-4000-8000-000000000005',70000,'KZT',-30,null,false,'confirmed'),
                 ('E7','tax','ca100000-0000-4000-8000-000000000005',60000,'KZT',-30,-15,false,'confirmed'),
                 ('E8','transport','ca100000-0000-4000-8000-000000000005',999,'KZT',-30,1,false,'draft'),
                 ('E5','goods_cost','ca100000-0000-4000-8000-000000000006',5000,'EUR',-30,14,false,'confirmed'),
                 ('E6','transport','ca100000-0000-4000-8000-000000000005',800,'EUR',-30,2,false,'confirmed'),
                 ('PL1','broker_fee','ca100000-0000-4000-8000-000000000005',120000,'KZT',20,null,true,'draft'),
                 ('PL2','transport','ca100000-0000-4000-8000-000000000005',30000,'KZT',8,null,true,'draft'))
         v(k,t,p,a,cur,inc,due,planned,s)
  returning id,notes)
insert into ca select notes,id from e;
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 values (pg_temp.cur('EUR'),pg_temp.cur('KZT'),500,'official',current_date,'ca000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000001',true);
set local role authenticated;
-- Payments: E1 100 000 of 400 000 on W-1; E7 paid in full on W-10, reversed, 10 000 refunded on W-1 (50 000 overpaid);
-- an advance of 500 EUR (services) on W-3, 300 set off against E6 (E6 rest 500, advance 200 free); a goods advance of
-- 1 000 EUR to the supplier on W-4.
select public.record_expense_payment(gen_random_uuid(),pg_temp.id('E1'),100000,pg_temp.w()-1,null,'Частичная оплата');
insert into ca values ('payE7',public.record_expense_payment(gen_random_uuid(),pg_temp.id('E7'),60000,pg_temp.w()-10,null,'Налог'));
select public.reverse_expense(pg_temp.id('E7'),'Начислен ошибочно');
select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payE7'),10000,pg_temp.w()-1,null,'Возврат части');
insert into ca values ('adv',public.record_advance_payment(gen_random_uuid(),'ca100000-0000-4000-8000-000000000005',pg_temp.cur('EUR'),500,
                                                          pg_temp.w()-3,'services',null,'Аванс перевозчику'));
select public.apply_advance(gen_random_uuid(),pg_temp.id('adv'),pg_temp.id('E6'),300);
select public.record_advance_payment(gen_random_uuid(),'ca100000-0000-4000-8000-000000000006',pg_temp.cur('EUR'),1000,
                                     pg_temp.w()-4,'goods',null,'Аванс за товар');

-- Planned payment date: E2 moves from T+5 to T+12, with a reason, in the audit log.
select pg_temp.fails($q$select public.set_expense_planned_payment_date(pg_temp.id('E2'),current_date+12,' ')$q$,'Укажите причину');
select public.set_expense_planned_payment_date(pg_temp.id('E2'),current_date+12,'Договорились с перевозчиком');
select pg_temp.fails($q$select public.set_expense_planned_payment_date(pg_temp.id('E2'),current_date+12,'Ещё раз')$q$,'не изменилась');
select pg_temp.fails($q$select public.set_expense_planned_payment_date(pg_temp.id('E7'),current_date+1,'Сторнирован')$q$,'сторнирован');
reset role;
do $$begin
 assert (select planned_payment_date=current_date+12 and due_date=current_date+5 from public.expenses where id=pg_temp.id('E2')),
   'the due date stays, the planned date is set';
 assert (select count(*)=1 and bool_and(actor_user_id='ca000000-0000-4000-8000-000000000001' and metadata->>'reason'='Договорились с перевозчиком'
           and before_data->>'planned_payment_date' is null and (after_data->>'planned_payment_date')::date=current_date+12)
           from public.audit_log where action='expense_planned_payment_date' and entity_id=pg_temp.id('E2')::text),'one audit entry with the reason';
end $$;
set local role authenticated;
select pg_temp.fails($q$select public.set_expense_planned_payment_date(gen_random_uuid(),current_date,'Нет такого')$q$,'не найден');
do $$declare v jsonb;begin
 v:=public.expense_payment_plans('ca100000-0000-4000-8000-000000000005');
 assert (select count(*)=1 from jsonb_array_elements(v) x where x->>'expense_id'=pg_temp.id('E2')::text
           and (x->>'planned_payment_date')::date=current_date+12 and x->>'reason'='Договорились с перевозчиком'
           and x->>'changed_by'='Cash director'),'the payee card shows the plan with who and why';
end $$;

-- Accounts. Kaspi KZT: 500 000 on T-5, then 1 000 000 today (the latest counts). Halyk EUR: 2 000 yesterday. An old KZT
-- account with 999 is closed and never counted.
insert into ca values ('kaspi',public.save_cash_account('Kaspi KZT','Kaspi Bank',pg_temp.cur('KZT'))),
                      ('halyk',public.save_cash_account('Halyk EUR',null,pg_temp.cur('EUR'))),
                      ('old',public.save_cash_account('Old KZT',null,pg_temp.cur('KZT')));
do $$begin assert public.save_cash_account(' kaspi kzt ',null,pg_temp.cur('KZT'))=pg_temp.id('kaspi'),'the same name and currency is the same account';end $$;
select pg_temp.fails($q$select public.save_cash_account('K',null,pg_temp.cur('KZT'))$q$,'название счёта');
select public.record_cash_balance(pg_temp.id('kaspi'),current_date-5,500000,'Выписка');
select public.record_cash_balance(pg_temp.id('kaspi'),current_date,1000000,null);
select public.record_cash_balance(pg_temp.id('halyk'),current_date-1,2000,null);
select public.record_cash_balance(pg_temp.id('old'),current_date,999,null);
select public.set_cash_account_active(pg_temp.id('old'),false);
select pg_temp.fails($q$select public.record_cash_balance(pg_temp.id('kaspi'),current_date+1,1,null)$q$,'в будущем');
select pg_temp.fails($q$select public.record_cash_balance(pg_temp.id('kaspi'),current_date,1.005,null)$q$,'до копеек');
select pg_temp.fails($q$select public.record_cash_balance(pg_temp.id('old'),current_date,1,null)$q$,'закрыт');
do $$
declare v jsonb := public.cash_account_list(); k jsonb;
begin
 assert (select array_agg(x->>'name' order by ord) from jsonb_array_elements(v) with ordinality t(x,ord))='{Kaspi KZT,Halyk EUR,Old KZT}',
   'active first, tenge first';
 k:=v->0;
 assert k->>'bank'='Kaspi Bank' and jsonb_array_length(k->'history')=2 and (k->'history'->0->>'amount')::numeric=1000000
    and k->'history'->1->>'note'='Выписка' and k->'history'->0->>'author'='Cash director' and not (v->2->>'is_active')::boolean;
end $$;
reset role;
select pg_temp.fails($q$update public.cash_account_balances set amount=1$q$,'неизменяема');
select pg_temp.fails($q$delete from public.cash_account_balances$q$,'неизменяема');
set local role authenticated;

-- 1. Days, director (every right). KZT: 1 000 000 at the start; T+3 pays E1's rest 300 000 -> 700 000; T+10 C1 pays
-- 300 000 -> 1 000 000; T+12 pays E2 1 200 000 -> -200 000: the gap. Plan: T+20 PL1 -120 000, T+21 S1 +10 000.
do $$
declare v jsonb := public.cash_calendar('day',31);
begin
 assert v->>'step'='day' and (v->>'from')::date=current_date and (v->>'to')::date=current_date+30 and (v->>'receivables')::boolean
    and (v->>'goods')::boolean and (v->>'can_manage')::boolean and (v->>'gap_alert_days')::integer=14,'the frame';
 assert (select array_agg(e->>'currency' order by ord) from jsonb_array_elements(v->'currencies') with ordinality x(e,ord))='{KZT,EUR}',
   'tenge first, currencies never added together';
 assert (pg_temp.c(v,'KZT')->'opening'->>'amount')::numeric=1000000 and (pg_temp.c(v,'KZT')->'opening'->>'as_of')::date=current_date
    and (pg_temp.c(v,'KZT')->'opening'->>'accounts')::integer=1,'the latest balance of the active account only';
 assert (pg_temp.p(v,'KZT',3)->>'out_payables')::numeric=300000 and (pg_temp.p(v,'KZT',3)->>'closing')::numeric=700000,'T+3: the rest of E1';
 assert (pg_temp.p(v,'KZT',10)->>'in_receivables')::numeric=300000 and (pg_temp.p(v,'KZT',10)->>'closing')::numeric=1000000,
   'T+10: the open part of C1';
 assert (pg_temp.p(v,'KZT',12)->>'out_payables')::numeric=1200000 and (pg_temp.p(v,'KZT',12)->>'closing')::numeric=-200000
    and (pg_temp.p(v,'KZT',12)->>'gap')::boolean and not (pg_temp.p(v,'KZT',11)->>'gap')::boolean,'T+12: E2 on its planned date, the gap';
 assert (pg_temp.p(v,'KZT',5)->>'out_payables')::numeric=0,'nothing left on the due date of E2';
 assert (pg_temp.c(v,'KZT')->>'first_gap')::date=current_date+12 and (pg_temp.c(v,'KZT')->>'first_gap_with_plan')::date=current_date+12;
 assert (pg_temp.p(v,'KZT',20)->>'out_planned')::numeric=120000 and (pg_temp.p(v,'KZT',21)->>'in_orders')::numeric=10000
    and (pg_temp.p(v,'KZT',21)->>'closing')::numeric=-200000 and (pg_temp.p(v,'KZT',21)->>'closing_with_plan')::numeric=-310000,
   'plan lines apart: confirmed -200 000, with plan -200 000 - 120 000 + 10 000';
 assert pg_temp.total(v,'KZT','out_planned')=120000,'PL2 is replaced by the actual transport';
 assert pg_temp.n(v,'KZT','overdue_in')=200000 and pg_temp.n(v,'KZT','overdue_out')=50000 and pg_temp.n(v,'KZT','no_date_out')=70000,
   'overdue and undated apart: C2 150 000 + 50 000; E3; E4';
 assert pg_temp.n(v,'KZT','orders_with_unpriced')=1,'S1 has a line without a price';
 assert pg_temp.n(v,'KZT','overpayments')=50000 and pg_temp.n(v,'KZT','advances')=0,'reference: 60 000 overpaid - 10 000 refunded';
 assert pg_temp.n(v,'KZT','rate_kzt')=1;
 -- EUR: 2 000; T+1 S3 +200 (plan); T+2 E6 rest 500 -> 1 500; T+14 E5 goods 5 000 -> -3 500.
 assert (pg_temp.c(v,'EUR')->'opening'->>'amount')::numeric=2000 and (pg_temp.c(v,'EUR')->'opening'->>'as_of')::date=current_date-1;
 assert (pg_temp.p(v,'EUR',1)->>'in_orders')::numeric=200 and (pg_temp.p(v,'EUR',2)->>'out_payables')::numeric=500
    and (pg_temp.p(v,'EUR',2)->>'closing')::numeric=1500,'E6: 800 - 300 set off from the advance, never twice';
 assert (pg_temp.p(v,'EUR',14)->>'out_payables')::numeric=5000 and (pg_temp.c(v,'EUR')->>'first_gap')::date=current_date+14;
 assert pg_temp.n(v,'EUR','later_in')=3000 and pg_temp.n(v,'EUR','advances')=1200,'C3 after the horizon; advances 200 + 1 000 goods';
 assert pg_temp.n(v,'EUR','rate_kzt')=500 and (pg_temp.p(v,'EUR',0)->>'closing_kzt')::numeric=1000000,'tenge estimate at today''s rate';
end $$;

-- 2. Weeks: the same money, summed. KZT at the end: 1 000 000 + 300 000 - 300 000 - 1 200 000 = -200 000; with plan -310 000.
do $$
declare v jsonb := public.cash_calendar('week',13); last jsonb;
begin
 assert (v->>'from')::date=pg_temp.w() and (v->>'to')::date=pg_temp.w()+90 and jsonb_array_length(pg_temp.c(v,'KZT')->'periods')=13;
 last:=pg_temp.p(v,'KZT',12);
 assert (last->>'closing')::numeric=-200000 and (last->>'closing_with_plan')::numeric=-310000;
 assert pg_temp.total(v,'KZT','out_payables')=1500000 and pg_temp.total(v,'KZT','in_receivables')=300000
    and pg_temp.total(v,'KZT','in_orders')=10000 and pg_temp.total(v,'KZT','out_planned')=120000;
 assert (pg_temp.c(v,'KZT')->>'first_gap')::date=date_trunc('week',current_date+12)::date,'the week of the gap';
 assert pg_temp.n(v,'EUR','later_in')=3000 and pg_temp.total(v,'EUR','out_payables')=5500;
end $$;

-- 3. Reconciliation with the registers: every open payable and every open receivable is in the calendar exactly once.
do $$
declare v jsonb := public.cash_calendar('week',13); r record; cal numeric; reg numeric;
begin
 for r in select * from (values ('KZT'),('EUR')) x(code) loop
  cal:=pg_temp.total(v,r.code,'out_payables')+pg_temp.n(v,r.code,'overdue_out')+pg_temp.n(v,r.code,'no_date_out')+pg_temp.n(v,r.code,'later_out');
  select coalesce(sum((s->>'rest')::numeric),0) into reg from jsonb_array_elements(public.payables_summary()) s where s->>'currency'=r.code;
  assert cal=reg,format('payables %s: calendar %s, register %s',r.code,cal,reg);
  select coalesce(sum((s->>'advances')::numeric),0) into reg from jsonb_array_elements(public.payables_summary()) s where s->>'currency'=r.code;
  assert pg_temp.n(v,r.code,'advances')=reg,format('advances %s',r.code);
  select coalesce(sum((s->>'overpaid')::numeric),0) into reg from jsonb_array_elements(public.payables_summary()) s where s->>'currency'=r.code;
  assert pg_temp.n(v,r.code,'overpayments')=reg,format('overpayments %s',r.code);
  cal:=pg_temp.total(v,r.code,'in_receivables')+pg_temp.n(v,r.code,'overdue_in')+pg_temp.n(v,r.code,'later_in');
  select coalesce(sum((a->>'not_due')::numeric+(a->>'overdue')::numeric),0) into reg
    from jsonb_array_elements(public.customer_receivables()) c cross join jsonb_array_elements(c->'aging') a where a->>'currency'=r.code;
  assert cal=reg,format('receivables %s: calendar %s, register %s',r.code,cal,reg);
 end loop;
 -- Hand values of the same: KZT payables 300 000 + 1 200 000 + 50 000 + 70 000; EUR 500 + 5 000; KZT receivables 500 000.
 assert pg_temp.total(v,'KZT','out_payables')+pg_temp.n(v,'KZT','overdue_out')+pg_temp.n(v,'KZT','no_date_out')=1620000;
 assert pg_temp.total(v,'KZT','in_receivables')+pg_temp.n(v,'KZT','overdue_in')=500000;
end $$;

-- 4. What makes a cell (the first 500 items, the number and the sums of all).
do $$
declare v jsonb; cell jsonb;
begin
 cell:=public.cash_calendar_items(pg_temp.cur('KZT'),'period',current_date,current_date+30);
 assert (cell->>'total')::integer=5 and (cell->>'amount_in')::numeric=310000 and (cell->>'amount_out')::numeric=1620000
    and jsonb_array_length(cell->'items')=5,'C1 300 000 + S1 10 000 in; E1 300 000 + E2 1 200 000 + PL1 120 000 out';
 v:=public.cash_calendar_items(pg_temp.cur('KZT'),'period',current_date+12,current_date+12)->'items';
 assert jsonb_array_length(v)=1 and v->0->>'ref_id'=pg_temp.id('E2')::text and (v->0->>'amount')::numeric=1200000
    and (v->0->>'date')::date=current_date+12 and (v->0->>'due_date')::date=current_date+5 and v->0->>'kind'='payable';
 v:=public.cash_calendar_items(pg_temp.cur('KZT'),'overdue')->'items';
 assert (select array_agg((x->>'amount')::numeric order by (x->>'amount')::numeric) from jsonb_array_elements(v) x)='{50000,50000,150000}',
   'C2 twice and E3';
 v:=public.cash_calendar_items(pg_temp.cur('KZT'),'no_date')->'items';
 assert jsonb_array_length(v)=1 and v->0->>'ref_id'=pg_temp.id('E4')::text;
 v:=public.cash_calendar_items(pg_temp.cur('EUR'),'later',current_date+31)->'items';
 assert jsonb_array_length(v)=1 and v->0->>'kind'='receivable' and (v->0->>'amount')::numeric=3000;
 v:=cell->'items';
 assert (select count(*) from jsonb_array_elements(v) x where x->>'kind'='order' and x->>'note'='unpriced_lines:1')=1;
 assert not exists (select 1 from jsonb_array_elements(v) x where x->>'ref_id' in (pg_temp.id('E8')::text,pg_temp.id('PL2')::text,
                                                                                    'ca400000-0000-4000-8000-000000000002')),
   'a draft expense, a replaced plan and a draft order are not money';
end $$;
select pg_temp.fails($q$select public.cash_calendar_items(pg_temp.cur('KZT'),'period',current_date,null)$q$,'период');
select pg_temp.fails($q$select public.cash_calendar('month',3)$q$,'неделя или день');
select pg_temp.fails($q$select public.cash_calendar('week',27)$q$,'до 26 недель');

-- 5. Plan and fact of the four past weeks (W-28 .. W-1), director. KZT: due 150 000 (C2, W-20) + 50 000 (C2, W-4) + 100 000
-- (C4, W-10); came 200 000 (C1) + 130 000 (C4) + 10 000 refund; due to pay E3 50 000 (T-7; E7 is reversed); paid 100 000
-- (E1) + 60 000 (E7). EUR: paid 500 + 1 000 advances (the set-off of 300 is not money).
do $$
declare v jsonb := public.cash_plan_fact(4); k jsonb; e jsonb;
begin
 assert (v->>'from')::date=pg_temp.w()-28 and (v->>'to')::date=pg_temp.w()-1;
 k:=(select x from jsonb_array_elements(v->'currencies') x where x->>'currency'='KZT');
 assert (select sum((w->>'plan_in')::numeric) from jsonb_array_elements(k->'weeks') w)=300000;
 assert (select sum((w->>'fact_in')::numeric) from jsonb_array_elements(k->'weeks') w)=340000;
 assert (select sum((w->>'plan_out')::numeric) from jsonb_array_elements(k->'weeks') w)=50000;
 assert (select sum((w->>'fact_out')::numeric) from jsonb_array_elements(k->'weeks') w)=160000;
 assert (select (w->>'fact_in')::numeric from jsonb_array_elements(k->'weeks') w where (w->>'start')::date=pg_temp.w()-7)=340000,
   'the last week: W-3, W-2 and the refund on W-1';
 e:=(select x from jsonb_array_elements(v->'currencies') x where x->>'currency'='EUR');
 assert (select sum((w->>'fact_out')::numeric) from jsonb_array_elements(e->'weeks') w)=1500;
end $$;

-- 6. Without the purchase prices: no goods payment, no goods advance, a mark; the goods expense cannot be planned.
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000002',true);
do $$
declare v jsonb := public.cash_calendar('day',31);
begin
 assert not (v->>'goods')::boolean and (v->>'receivables')::boolean;
 assert (pg_temp.p(v,'EUR',14)->>'out_payables')::numeric=0 and (pg_temp.c(v,'EUR')->>'first_gap') is null
    and pg_temp.n(v,'EUR','advances')=200,'EUR without goods: 1 500 at the end, the services advance only';
 assert not exists (select 1 from jsonb_array_elements(public.cash_calendar_items(pg_temp.cur('EUR'),'period',current_date,current_date+30)->'items') x
                     where x->>'note'='goods_cost'),'no goods expense in the cell either';
 assert (select sum((w->>'fact_out')::numeric) from jsonb_array_elements(public.cash_plan_fact(4)->'currencies') x
          cross join jsonb_array_elements(x->'weeks') w where x->>'currency'='EUR')=500,'no goods advance in the fact';
end $$;
select pg_temp.fails($q$select public.set_expense_planned_payment_date(pg_temp.id('E5'),current_date+20,'Позже')$q$,'стоимости товара');

-- 7. Without receivables: no customer debts and no orders; the payables stay.
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000004',true);
do $$
declare v jsonb := public.cash_calendar('day',31);
begin
 assert not (v->>'receivables')::boolean and (v->>'goods')::boolean;
 assert pg_temp.total(v,'KZT','in_receivables')=0 and pg_temp.total(v,'KZT','in_orders')=0 and pg_temp.n(v,'KZT','overdue_in')=0
    and pg_temp.n(v,'EUR','later_in')=0 and pg_temp.total(v,'KZT','out_payables')=1500000;
 assert (pg_temp.c(v,'KZT')->>'first_gap')::date=current_date+12 and (pg_temp.p(v,'KZT',12)->>'closing')::numeric=-500000;
 assert (select count(*) from jsonb_array_elements(public.cash_calendar_items(pg_temp.cur('KZT'),'overdue')->'items') x)=1,'E3 only';
 assert (select sum((w->>'plan_in')::numeric+(w->>'fact_in')::numeric) from jsonb_array_elements(public.cash_plan_fact(4)->'currencies') x
          cross join jsonb_array_elements(x->'weeks') w where x->>'currency'='KZT')=10000,'only the refund from the payee';
end $$;

-- 8. Without finance: nothing.
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000003',true);
select pg_temp.fails($q$select public.cash_calendar()$q$,'Нет доступа к платёжному календарю');
select pg_temp.fails($q$select public.cash_calendar_items(pg_temp.cur('KZT'),'no_date')$q$,'Нет доступа к платёжному календарю');
select pg_temp.fails($q$select public.cash_plan_fact()$q$,'Нет доступа к платёжному календарю');
select pg_temp.fails($q$select public.expense_payment_plans(null)$q$,'Нет доступа к платёжному календарю');
select pg_temp.fails($q$select public.cash_account_list()$q$,'Нет доступа к платёжному календарю');
select pg_temp.fails($q$select public.record_cash_balance(pg_temp.id('kaspi'),current_date,1,null)$q$,'Нет права изменять');
select pg_temp.fails($q$select public.set_expense_planned_payment_date(pg_temp.id('E1'),current_date+1,'Позже')$q$,'Нет права изменять');
select pg_temp.fails($q$select public.set_cash_gap_alert_days(7)$q$,'Нет права изменять');
select pg_temp.fails($q$select public.run_cash_gap_control()$q$,'permission denied');
select pg_temp.fails($q$select * from public.cash_accounts$q$,'permission denied');
reset role;

-- 9. The daily gap control (service role) with the rights of each employee, horizon 14 days. Director: KZT (T+12) and EUR
-- (T+14); accountant without prices: KZT only; accountant without receivables: KZT (T+12) and EUR (T+14); logistics: none.
set local role service_role;
select set_config('tests.cash_gap_created',public.run_cash_gap_control()::text,true);
select set_config('tests.cash_gap_again',public.run_cash_gap_control()::text,true);
reset role;
do $$
begin
 assert current_setting('tests.cash_gap_created')::integer=(select count(*) from public.notifications where type='cash_gap'),
   'the count is what was created';
 assert (select count(*) from public.notifications where type='cash_gap' and recipient_user_id='ca000000-0000-4000-8000-000000000001')=2;
 assert (select count(*) from public.notifications where type='cash_gap' and recipient_user_id='ca000000-0000-4000-8000-000000000002')=1;
 assert (select count(*) from public.notifications where type='cash_gap' and recipient_user_id='ca000000-0000-4000-8000-000000000004')=2;
 assert not exists (select 1 from public.notifications where recipient_user_id='ca000000-0000-4000-8000-000000000003');
 assert (select bool_and(entity_type='cash_calendar' and entity_id is null and shipment_id is null
           and body !~ '200[  ]?000|3[  ]?500|5[  ]?000|1[  ]?200[  ]?000' and title in ('Кассовый разрыв: KZT','Кассовый разрыв: EUR'))
           from public.notifications where type='cash_gap'),'currency and week, never an amount';
 assert exists (select 1 from public.notifications where type='cash_gap' and recipient_user_id='ca000000-0000-4000-8000-000000000001'
                  and body like '%' || to_char(current_date+12,'DD.MM.YYYY') || '%'
                  and body like '%неделя с ' || to_char(date_trunc('week',current_date+12),'DD.MM.YYYY') || '%');
 assert current_setting('tests.cash_gap_again')::integer=0,'once a business day';
end $$;
do $$
declare n public.notifications;
begin
 select * into n from public.notifications where type='cash_gap' and recipient_user_id='ca000000-0000-4000-8000-000000000001' limit 1;
 assert 'cash_gap'=any(private.telegram_notification_types());
 assert private.telegram_notification_allowed('ca000000-0000-4000-8000-000000000001',n)
    and not private.telegram_notification_allowed('ca000000-0000-4000-8000-000000000003',n),'Telegram: finance.view decides';
end $$;

-- 10. A shorter horizon (finance.manage) sees fewer gaps: 11 days do not reach T+12 or T+14.
update public.cash_calendar_settings set last_gap_check=null;
delete from public.notifications where type='cash_gap';
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select pg_temp.fails($q$select public.set_cash_gap_alert_days(31)$q$,'от 1 до 30');
select public.set_cash_gap_alert_days(11);
reset role;
set local role service_role;
select set_config('tests.cash_gap_short',public.run_cash_gap_control()::text,true);
reset role;
do $$begin assert current_setting('tests.cash_gap_short')::integer=0;end $$;

-- 11. An account without a balance: the start of its currency is unknown, so no gap is claimed there.
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into ca values ('kaspi2',public.save_cash_account('Kaspi KZT 2',null,pg_temp.cur('KZT')));
do $$
declare v jsonb := public.cash_calendar('day',31);
begin
 assert (pg_temp.c(v,'KZT')->'opening'->>'amount') is null and (pg_temp.c(v,'KZT')->'opening'->>'accounts_without_balance')::integer=1
    and (pg_temp.c(v,'KZT')->>'first_gap') is null and (pg_temp.p(v,'KZT',12)->>'closing') is null
    and (pg_temp.p(v,'KZT',12)->>'out_payables')::numeric=1200000,'flows stay, the balance is unknown';
end $$;
reset role;

-- 202611280400: the payables, cash and receivables tiles of the executive dashboard are these reports on the same data.
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare
  s jsonb := public.payables_summary(); d jsonb := public.cash_calendar('day',14); w jsonb := public.cash_calendar('week',13);
  t jsonb; cur text; e jsonb;
begin
  t := public.executive_dashboard_tile('payables');
  for cur in select unnest(array['KZT','EUR']) loop
    e := (select x from jsonb_array_elements(t->'currencies') x where x->>'currency'=cur);
    assert (e->>'overdue')::numeric=(select coalesce(sum((y->>'overdue_amount')::numeric),0) from jsonb_array_elements(s) y where y->>'currency'=cur),
      format('overdue %s = the register',cur);
    assert (e->>'due_14')::numeric=(select coalesce(sum((p->>'out_payables')::numeric),0) from jsonb_array_elements(d->'currencies') c
                                     cross join jsonb_array_elements(c->'periods') p where c->>'currency'=cur),format('due in 14 days %s = the calendar',cur);
  end loop;
  -- Hand values: KZT overdue E3 50 000, due E1 300 000 (T+3) + E2 1 200 000 (T+12); EUR due E6 500 (E5 on T+14 is the 15th day).
  e := (select x from jsonb_array_elements(t->'currencies') x where x->>'currency'='KZT');
  assert (e->>'overdue')::numeric=50000 and (e->>'due_14')::numeric=1500000;
  e := (select x from jsonb_array_elements(t->'currencies') x where x->>'currency'='EUR');
  assert (e->>'overdue')::numeric=0 and (e->>'due_14')::numeric=500 and (e->>'due_14_kzt')::numeric=250000 and (t->>'goods')::boolean;
  t := public.executive_dashboard_tile('cash');
  assert (t->'nearest'->>'currency')='EUR' and (t->'nearest'->>'date')=(select c->>'first_gap' from jsonb_array_elements(w->'currencies') c where c->>'currency'='EUR'),
    'the nearest gap = the calendar (KZT has an account without a balance now: no gap claimed there)';
  assert (t->>'incomplete')::boolean and not (select (x->>'balance_known')::boolean from jsonb_array_elements(t->'currencies') x where x->>'currency'='KZT');
  t := public.executive_dashboard_tile('receivables');
  assert (select (x->>'overdue')::numeric from jsonb_array_elements(t->'currencies') x where x->>'currency'='KZT')
       =(select sum((a->>'overdue')::numeric) from jsonb_array_elements(public.customer_receivables()) c cross join jsonb_array_elements(c->'aging') a
          where a->>'currency'='KZT'),'overdue receivables = the register';
  assert (t->>'customers')::integer=1 and t->'top'->0->>'customer'='Должник' and (t->'top'->0->>'kzt')::numeric=200000;
end $$;
reset role;
select set_config('request.jwt.claim.sub','ca000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.executive_dashboard_tile('cash')$q$,'Нет доступа к дашборду руководителя');
reset role;

rollback;
\echo 'cash_calendar: all checks passed'
