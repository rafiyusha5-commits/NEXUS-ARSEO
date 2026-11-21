-- 202611210200: what was paid against a reversed expense is the payee's debt ("переплата"): shown in the register and
-- closed by a refund or by a set-off of the same kind. Synthetic data only; hand calculations next to every check.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ad200000-0000-4000-8000-000000000001','overpay-director@example.invalid','{"full_name":"Overpayment director"}'),
 ('ad200000-0000-4000-8000-000000000002','overpay-logistics@example.invalid','{"full_name":"Logistics without payment right"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ad200000-0000-4000-8000-000000000001'::uuid,'director'),('ad200000-0000-4000-8000-000000000002'::uuid,'logistics_specialist')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ad210000-0000-4000-8000-000000000001',array['customer'],'Overpayment customer','KZ','AD2-C'),
 ('ad210000-0000-4000-8000-000000000002',array['carrier'],'Overpayment carrier','KZ','AD2-P');
create temporary table ad2(k text primary key,id uuid);
grant all on ad2 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from ad2 where k=p_key $$;
create function pg_temp.free(p_key text) returns numeric language sql stable security definer as $$ select private.payment_unapplied((select id from ad2 where k=p_key)) $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Confirmed expenses of the carrier in EUR: A transport 100, B transport 50, G goods 80.
with e as (
  insert into public.expenses(attributed_customer_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,is_planned,status,
                              confirmed_by,confirmed_at,created_by,notes)
  select 'ad210000-0000-4000-8000-000000000001',v.t,'ad210000-0000-4000-8000-000000000002',v.a,
         (select id from public.currencies where code='EUR'),current_date-10,false,'confirmed',
         'ad200000-0000-4000-8000-000000000001',now(),'ad200000-0000-4000-8000-000000000001',v.k
    from (values ('A','transport',100),('B','transport',50),('G','goods_cost',80)) v(k,t,a)
  returning id, notes)
insert into ad2 select notes, id from e;

select set_config('request.jwt.claim.sub','ad200000-0000-4000-8000-000000000001',true);
set local role authenticated;
-- 1. A is paid 60 of 100 and then reversed: the 60 is the carrier's debt.
insert into ad2 values ('payA',public.record_expense_payment(gen_random_uuid(),pg_temp.id('A'),60,current_date-5,null,'Частичная оплата'));
select public.reverse_expense(pg_temp.id('A'),'Перевозка не состоялась');
reset role;
do $$
declare s jsonb; c jsonb; o jsonb;
begin
 assert pg_temp.free('payA')=60,'60 paid against the reversed expense is free again';
 select r into s from jsonb_array_elements(public.payables_summary()) r where r->>'payee_id'='ad210000-0000-4000-8000-000000000002';
 assert (s->>'overpaid')::numeric=60 and (s->>'advances')::numeric=0,'the register shows the overpayment, not an advance';
 assert (s->>'accrued')::numeric=130 and (s->>'paid')::numeric=0,'debt: B 50 + G 80; the reversed A is not a debt any more';
 c:=public.payables_payee('ad210000-0000-4000-8000-000000000002');
 assert jsonb_array_length(c->'overpayments')=1;
 o:=c->'overpayments'->0;
 assert (o->>'remaining')::numeric=60 and o->>'advance_for'='services' and o->'reversed'->0->>'reason'='Перевозка не состоялась'
   and (o->'reversed'->0->>'paid')::numeric=60,'the card names the reversed expense, what was paid and why';
end $$;
set local role authenticated;

-- 2. Refund: 25 back from the carrier; repeating the request changes nothing; more than is free is refused.
insert into ad2 values ('refund1','ad2f0000-0000-4000-8000-000000000001');
select public.record_payment_refund(pg_temp.id('refund1'),pg_temp.id('payA'),25,current_date-1,null,'Возврат по письму');
select public.record_payment_refund(pg_temp.id('refund1'),pg_temp.id('payA'),25,current_date-1,null,'Возврат по письму');
select pg_temp.fails($q$select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payA'),36,current_date,null,null)$q$,'Возврат больше остатка: можно вернуть не больше 35');
select pg_temp.fails($q$select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payA'),5,current_date+1,null,null)$q$,'в будущем');
select pg_temp.fails($q$select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payA'),5,current_date-30,null,null)$q$,'раньше даты оплаты');
select pg_temp.fails($q$select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payA'),0,current_date,null,null)$q$,'больше нуля');
reset role;
do $$begin
 assert pg_temp.free('payA')=35,'60 - 25 = 35';
 assert (select count(*) from public.payment_refunds where payment_id=pg_temp.id('payA'))=1,'the repeated request made no second refund';
end $$;
set local role authenticated;

-- 3. Set-off: 30 of the overpayment pays B (transport); a goods expense is refused.
select public.apply_advance(gen_random_uuid(),pg_temp.id('payA'),pg_temp.id('B'),30);
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('payA'),pg_temp.id('G'),5)$q$,'Переплату за услуги нельзя зачесть в расход за товар');
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('payA'),pg_temp.id('B'),10)$q$,'остаток 5');
reset role;
do $$
declare s jsonb;
begin
 assert pg_temp.free('payA')=5,'35 - 30 = 5';
 assert private.expense_paid_amount(pg_temp.id('B'))=30,'B is paid 30 by the set-off';
 select r into s from jsonb_array_elements(public.payables_summary()) r where r->>'payee_id'='ad210000-0000-4000-8000-000000000002';
 assert (s->>'overpaid')::numeric=5 and (s->>'paid')::numeric=30;
 assert (select count(*) from public.payment_applications where expense_id=pg_temp.id('A'))=1,'the history of the reversed expense is kept';
end $$;
set local role authenticated;
-- The last 5 is refunded: the overpayment is closed and leaves the register.
select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payA'),5,current_date,null,'Остаток');
reset role;
do $$begin
 assert pg_temp.free('payA')=0;
 assert not exists(select 1 from jsonb_array_elements(public.payables_summary()) r
                    where r->>'payee_id'='ad210000-0000-4000-8000-000000000002' and (r->>'overpaid')::numeric>0);
end $$;
set local role authenticated;

-- 4. An ordinary payment cannot be "refunded"; the unused rest of an advance can.
insert into ad2 values ('payB2',public.record_expense_payment(gen_random_uuid(),pg_temp.id('B'),10,current_date,null,null));
select pg_temp.fails($q$select public.record_payment_refund(gen_random_uuid(),pg_temp.id('payB2'),1,current_date,null,null)$q$,'Аванс или переплата не найдены');
insert into ad2 values ('adv',public.record_advance_payment(gen_random_uuid(),'ad210000-0000-4000-8000-000000000002',
  (select id from public.currencies where code='EUR'),40,current_date-2,'services'));
select public.apply_advance(gen_random_uuid(),pg_temp.id('adv'),pg_temp.id('B'),10);
select public.record_payment_refund(gen_random_uuid(),pg_temp.id('adv'),30,current_date,null,'Неиспользованный аванс');
reset role;
do $$begin
 assert pg_temp.free('adv')=0,'40 - 10 set off - 30 refunded';
 assert private.expense_paid_amount(pg_temp.id('B'))=50,'B: 30 + 10 + 10 = 50, paid in full';
 assert jsonb_array_length((select a->'refunds' from jsonb_array_elements(public.payables_payee('ad210000-0000-4000-8000-000000000002')->'advances') a
                             where a->>'id'=pg_temp.id('adv')::text))=1,'the card shows the refund of the advance';
end $$;
set local role authenticated;
reset role;

-- 5. Rights and history.
select set_config('request.jwt.claim.sub','ad200000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.record_payment_refund(gen_random_uuid(),pg_temp.id('adv'),1,current_date,null,null)$q$,'Нет права записывать возврат');
select pg_temp.fails($q$select * from public.payment_refunds$q$,'permission denied');
reset role;
select pg_temp.fails($q$update public.payment_refunds set amount=1$q$,'неизменяема');
select pg_temp.fails($q$delete from public.payment_refunds$q$,'неизменяема');
do $$begin
 assert not has_function_privilege('anon','public.record_payment_refund(uuid,uuid,numeric,date,uuid,text)','execute');
end $$;
\echo reversed_expense_overpayment: all checks passed
rollback;
