-- 202611170700: advances to suppliers and carriers, set off later against expenses. Synthetic data only.
-- Hand calculations next to every check. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ab800000-0000-4000-8000-000000000001','advance-director@example.invalid','{"full_name":"Advance director"}'),
 ('ab800000-0000-4000-8000-000000000002','advance-accountant@example.invalid','{"full_name":"Accountant without purchase prices"}'),
 ('ab800000-0000-4000-8000-000000000003','advance-logistics@example.invalid','{"full_name":"Logistics without payment right"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ab800000-0000-4000-8000-000000000001'::uuid,'director'),('ab800000-0000-4000-8000-000000000002'::uuid,'accountant'),
 ('ab800000-0000-4000-8000-000000000003'::uuid,'logistics_specialist')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ab800000-0000-4000-8000-000000000002',id,'deny','No purchase prices','ab800000-0000-4000-8000-000000000001'
 from public.permissions where code='prices.purchase.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ab810000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Advance supplier','FI','AB8-SUP'),
 ('ab810000-0000-4000-8000-000000000002',array['carrier'],'Advance carrier','KZ','AB8-CAR'),
 ('ab810000-0000-4000-8000-000000000003',array['carrier'],'Other carrier','KZ','AB8-OTH');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ab840000-0000-4000-8000-000000000001','AB8-A','{"ru":"Товар аванса"}','ab810000-0000-4000-8000-000000000001','active');
create temporary table ab8(k text primary key,id uuid);
grant all on ab8 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from ab8 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.e(p_key text) returns public.expenses language sql stable security definer as $$ select * from public.expenses where id=(select id from ab8 where k=p_key) $$;
create function pg_temp.left_of(p_key text) returns numeric language sql stable security definer as $$ select private.payment_unapplied((select id from ab8 where k=p_key)) $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Expenses of the carrier: freight 300 EUR (allocated later), freight 200 EUR, 50 000 KZT; an expense of another carrier.
select set_config('request.jwt.claim.sub','ab800000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v_ship uuid;v_t uuid;
begin
 v_ship:=public.create_shipment_with_stages('AB8-SHIP','import','ab810000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),auth.uid(),current_date,current_date+14);
 perform public.add_shipment_transport(v_ship,null,null,null,null);
 select id into v_t from public.shipment_transports where shipment_id=v_ship;
 perform public.allocate_shipment_item(public.create_shipment_item(v_ship,'ab840000-0000-4000-8000-000000000001',
  'piece',100,10,pg_temp.cur('EUR')),v_t,100);
 insert into ab8 values('ship',v_ship),
  ('f300',public.create_expense(v_ship,'transport','ab810000-0000-4000-8000-000000000002',300,pg_temp.cur('EUR'),current_date,false,null,'Перевозка 300')),
  ('f200',public.create_expense(v_ship,'transport','ab810000-0000-4000-8000-000000000002',200,pg_temp.cur('EUR'),current_date,false,null,'Перевозка 200')),
  ('kzt',public.create_expense(v_ship,'transport','ab810000-0000-4000-8000-000000000002',50000,pg_temp.cur('KZT'),current_date,false,null,'Перевозка по РК')),
  ('other',public.create_expense(v_ship,'transport','ab810000-0000-4000-8000-000000000003',100,pg_temp.cur('EUR'),current_date,false,null,'Другой перевозчик')),
  ('goods',public.create_expense(v_ship,'goods_cost','ab810000-0000-4000-8000-000000000001',1000,pg_temp.cur('EUR'),current_date,false,null,'Товар'));
 perform public.confirm_expense(pg_temp.id(k)) from unnest(array['f300','f200','kzt','other','goods']) k;
 perform public.allocate_expense(pg_temp.id('f300'),'by_quantity',pg_temp.cur('EUR'));
end $$;

-- 1. An advance of 400 EUR to the carrier before the invoices (services); repeating the request is one advance.
insert into ab8 values('adv',public.record_advance_payment('ab820000-0000-4000-8000-000000000001','ab810000-0000-4000-8000-000000000002',
 pg_temp.cur('EUR'),400,current_date-3,'services',null,'Предоплата за перевозку'));
select public.record_advance_payment('ab820000-0000-4000-8000-000000000001','ab810000-0000-4000-8000-000000000002',
 pg_temp.cur('EUR'),400,current_date-3,'services',null,'Предоплата за перевозку');
select pg_temp.fails($q$select public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000002',pg_temp.cur('EUR'),0,current_date,'services')$q$,'больше нуля');
select pg_temp.fails($q$select public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000002',pg_temp.cur('EUR'),1,current_date,'gifts')$q$,'товар или услуги');
select pg_temp.fails($q$select public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000002',pg_temp.cur('EUR'),1,current_date+1,'services')$q$,'в будущем');
-- An advance for goods to the supplier: 600 EUR.
insert into ab8 values('adv_goods',public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000001',
 pg_temp.cur('EUR'),600,current_date-10,'goods',null,'Предоплата за товар'));
do $$declare r jsonb;begin
 assert (select count(*) from jsonb_array_elements(public.payables_payee('ab810000-0000-4000-8000-000000000002')->'advances'))=1,'one advance for one request';
 -- Register: the carrier owes 300 + 200 = 500 EUR and has an open advance of 400 EUR, shown side by side.
 select x into r from jsonb_array_elements(public.payables_summary()) x where x->>'payee'='Advance carrier' and x->>'currency'='EUR';
 assert r->>'rest'='500.00' and r->>'advances'='400.00';
 -- A payee with only an advance is in the register too.
 select x into r from jsonb_array_elements(public.payables_summary()) x where x->>'payee'='Advance supplier' and x->>'currency'='EUR';
 assert r->>'advances'='600.00' and r->>'rest'='1000.00';
end $$;

-- 2. Set off: 300 of the advance to the allocated 300 EUR freight (fully paid -> paid), 100 to the 200 EUR one.
select public.apply_advance('ab830000-0000-4000-8000-000000000001',pg_temp.id('adv'),pg_temp.id('f300'),300);
select public.apply_advance('ab830000-0000-4000-8000-000000000001',pg_temp.id('adv'),pg_temp.id('f300'),300);
select public.apply_advance(gen_random_uuid(),pg_temp.id('adv'),pg_temp.id('f200'),100);
reset role;
do $$begin
 assert (pg_temp.e('f300')).status='paid','fully paid by the advance';
 assert private.expense_paid_amount(pg_temp.id('f300'))=300 and private.expense_paid_amount(pg_temp.id('f200'))=100;
 assert pg_temp.left_of('adv')=0,'400 = 300 + 100, nothing left';
end $$;
set local role authenticated;
-- More than the advance, another currency, another payee, more than the expense: refused.
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv'),pg_temp.id('f200'),1)$q$,'остаток 0');
insert into ab8 values('adv2',public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000002',pg_temp.cur('EUR'),500,current_date,'services',null,null));
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv2'),pg_temp.id('kzt'),10)$q$,'валюте расхода');
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv2'),pg_temp.id('other'),10)$q$,'другому получателю');
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv2'),pg_temp.id('f200'),101)$q$,'осталось оплатить 100');
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),gen_random_uuid(),pg_temp.id('f200'),1)$q$,'Аванс не найден');
select public.apply_advance(gen_random_uuid(),pg_temp.id('adv2'),pg_temp.id('f200'),100);
-- Carrier EUR: 500 accrued, 500 paid (all through advances), remainder 400 of the second advance.
do $$declare r jsonb;c jsonb;begin
 select x into r from jsonb_array_elements(public.payables_summary()) x where x->>'payee'='Advance carrier' and x->>'currency'='EUR';
 assert r->>'accrued'='500.00' and r->>'paid'='500.00' and r->>'rest'='0.00' and r->>'advances'='400.00','debt settled by advances, remainder shown';
 c:=public.payables_payee('ab810000-0000-4000-8000-000000000002');
 assert (select x->>'remaining'='0.00' and jsonb_array_length(x->'applications')=2 from jsonb_array_elements(c->'advances') x where x->>'id'=pg_temp.id('adv')::text);
 assert (select (x->'payments'->0->>'advance')::boolean from jsonb_array_elements(c->'expenses') x where x->>'id'=pg_temp.id('f300')::text),'the card says the expense was paid by an advance';
end $$;
reset role;

-- 3. Goods: without purchase prices an advance for goods is neither visible nor usable.
select set_config('request.jwt.claim.sub','ab800000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$begin
 assert not exists(select 1 from jsonb_array_elements(public.payables_summary()) x where x->>'payee'='Advance supplier'),'goods advance hidden';
 assert jsonb_array_length(public.payables_payee('ab810000-0000-4000-8000-000000000001')->'advances')=0;
end $$;
select pg_temp.fails($q$select public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000001',pg_temp.cur('EUR'),1,current_date,'goods')$q$,'стоимости товара');
select pg_temp.fails($q$select public.apply_advance(gen_random_uuid(),pg_temp.id('adv_goods'),pg_temp.id('goods'),1)$q$,'стоимости товара');
reset role;
select set_config('request.jwt.claim.sub','ab800000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.record_advance_payment(gen_random_uuid(),'ab810000-0000-4000-8000-000000000002',pg_temp.cur('EUR'),1,current_date,'services')$q$,'Нет права');
reset role;

-- 4. History cannot be edited; an advance without a payee is refused by the table.
select pg_temp.fails($q$update public.payments set amount=1 where kind='advance'$q$,'неизменяема');
select pg_temp.fails($q$insert into public.payments(currency_id,amount,paid_on,created_by,kind,advance_for) values(pg_temp.cur('EUR'),1,current_date,'ab800000-0000-4000-8000-000000000001','advance','services')$q$,'payments_advance_check');
do $$begin
 assert not has_function_privilege('anon','public.record_advance_payment(uuid,uuid,uuid,numeric,date,text,uuid,text)','execute');
 assert not has_function_privilege('authenticated','private.open_advances()','execute');
end $$;
rollback;
\echo supplier_advances: all checks passed
