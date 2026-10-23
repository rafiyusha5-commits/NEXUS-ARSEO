-- Receivables (202609277600): opening balance from 1С, shipments due after the contract deferral, payments from the
-- bank statement matched by BIN or order number, returns, adjustments, FIFO ageing, reconciliation acts, and the
-- warning with a recorded decision before an order of a customer at risk is confirmed.
-- Shipping to the customer is simulated (it belongs to the fulfillment of customer orders).
\set ON_ERROR_STOP 1
begin;

-- Test-only fixture adapters for the unchanged historical ledger arithmetic below.
-- Production authenticated EXECUTE on these old writers is revoked. New import entry points,
-- rights, explicit replacement and idempotency are exercised in receivables_import_safety.test.sql.
create function pg_temp.ledger_fixture_bank(text,text,text,date,date,text,jsonb) returns jsonb
language sql security definer set search_path='' as $$ select public.import_bank_statement($1,$2,$3,$4,$5,$6,$7) $$;
create function pg_temp.ledger_fixture_opening(date,jsonb,text default null) returns jsonb
language sql security definer set search_path='' as $$ select public.import_opening_balances($1,$2,$3) $$;
grant execute on function pg_temp.ledger_fixture_bank(text,text,text,date,date,text,jsonb),pg_temp.ledger_fixture_opening(date,jsonb,text) to authenticated;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ef000000-0000-4000-8000-000000000001','recv-director@test.local','{"full_name":"Receivables Director"}'),
 ('ef000000-0000-4000-8000-000000000002','recv-sales@test.local','{"full_name":"Receivables Sales"}'),
 ('ef000000-0000-4000-8000-000000000003','recv-accountant@test.local','{"full_name":"Receivables Accountant"}');
insert into public.user_roles(user_id,role_id) select v.u::uuid,r.id from (values
 ('ef000000-0000-4000-8000-000000000001','director'),('ef000000-0000-4000-8000-000000000002','director'),
 ('ef000000-0000-4000-8000-000000000003','accountant')) v(u,role)
 join public.app_roles r on r.code=v.role;
-- A sales manager who works with orders but does not see the receivables.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'ef000000-0000-4000-8000-000000000002'::uuid,p.id,'deny','receivables test','ef000000-0000-4000-8000-000000000001'
from public.permissions p where p.code in ('receivables.view','receivables.manage');
insert into public.counterparties(id,roles,legal_name,short_name,country,tax_id) values
 ('ef100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Recv Supplier',null,'FI','RECV-SUP'),
 ('ef100000-0000-4000-8000-000000000002',array['customer'],'ТОО «Дебитор»','Дебитор','KZ','1234 5678 9012'),
 ('ef100000-0000-4000-8000-000000000003',array['customer'],'ТОО «Старый долг»',null,'KZ','210987654321');
insert into public.contracts(id,counterparty_id,number,type,status,sign_date) values
 ('ef500000-0000-4000-8000-000000000001','ef100000-0000-4000-8000-000000000002','Д-1','sale','active',current_date-400);
insert into public.contract_terms(contract_id,term_type,value_numeric,valid_from) values
 ('ef500000-0000-4000-8000-000000000001','payment_terms',30,current_date-400);
insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values
 ('ef200000-0000-4000-8000-000000000001','RECV-001','{"ru":"Товар в долг"}','ef100000-0000-4000-8000-000000000001','active',400);

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
create function pg_temp.aging(p_customer text,p_currency text default 'KZT') returns jsonb language sql as $$
 select e from jsonb_array_elements(public.customer_statement(p_customer::uuid)->'aging') e where e->>'currency'=p_currency $$;
grant execute on function pg_temp.aging(text,text) to authenticated;
create function pg_temp.sha(p text) returns text language sql as $$ select encode(sha256(convert_to(p,'UTF8')),'hex') $$;
grant execute on function pg_temp.sha(text) to authenticated;

insert into rt select 'warehouse',id from public.warehouses where status='active' and not is_virtual order by code limit 1;
insert into public.inventory_batches(id,product_id,batch_number,manufacture_date,expiry_date,created_by) values
 ('ef300000-0000-4000-8000-000000000001','ef200000-0000-4000-8000-000000000001','RECV-B1',current_date-50,current_date+300,'ef000000-0000-4000-8000-000000000001');
insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ef400000-0000-4000-8000-000000000001','ef300000-0000-4000-8000-000000000001',pg_temp.id('warehouse'),'piece',100);

set role authenticated;

-- ---------- rights ----------
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',false);
select pg_temp.fails($$select public.customer_receivables()$$,'Нет доступа к дебиторской');
select pg_temp.fails($$select public.customer_statement('ef100000-0000-4000-8000-000000000002')$$,'Нет доступа к дебиторской');
select pg_temp.fails($$select pg_temp.ledger_fixture_opening(current_date,'[{"bin":"123456789012","amount":1}]')$$,'Нет права вести');
select pg_temp.fails($$select pg_temp.ledger_fixture_bank('x.txt',repeat('a',64),null,null,null,'KZT','[]')$$,'Нет права вести');
select pg_temp.fails($$insert into public.customer_balance_adjustments(customer_id,currency_id,entry_date,amount,reason) values('ef100000-0000-4000-8000-000000000002',(select id from public.currencies where code='KZT'),current_date,1,'x')$$,'permission denied');

-- ---------- opening balance from the 1С report ----------
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000003',false);
select public.set_customer_credit_terms('ef100000-0000-4000-8000-000000000002',null,null,10);
select pg_temp.fails($$select pg_temp.ledger_fixture_opening(current_date+1,'[{"bin":"123456789012","amount":1}]')$$,'будущем');
select pg_temp.fails($$select pg_temp.ledger_fixture_opening(current_date,'[{"bin":"123456789012","amount":"1"}]')$$,'числом');
do $$ declare r jsonb := pg_temp.ledger_fixture_opening(current_date-40,
  '[{"bin":"123456789012","amount":1000,"contract":"Д-1"},{"name":"ТОО «Дебитор»","amount":500,"contract":"Д-2"},
    {"name":"Нет такого","bin":"000","amount":5},{"name":"тоо «старый долг»","amount":300}]'::jsonb,'Взаиморасчёты.xlsx');
begin
 assert (r->>'applied')::int=3,'three rows applied: '||r::text;
 assert jsonb_array_length(r->'unmatched')=1 and r->'unmatched'->0->>'name'='Нет такого','the unknown customer is reported back';
end $$;
do $$ begin
 assert (select amount=1500 and contract_number='Д-1, Д-2' from public.customer_opening_balances
         where customer_id='ef100000-0000-4000-8000-000000000002' and superseded_at is null),'contracts of one customer are summed';
 -- Opening debt is due after the customer's deferral: 30 days ago, so overdue 30 days.
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'overdue_1_30')::numeric=1500,'opening debt overdue 30 days';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'max_days_overdue')::int=30,'30 days';
 -- No deferral for the old customer: due on the balance date, 40 days.
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000003')->>'overdue_31_60')::numeric=300,'old debt 31-60';
end $$;
-- A newer report replaces the old row, it does not add up.
select pg_temp.ledger_fixture_opening(current_date-100,'[{"bin":"210987654321","amount":300}]');
do $$ begin
 assert (select count(*)=1 from public.customer_opening_balances where customer_id='ef100000-0000-4000-8000-000000000003' and superseded_at is null),'one active row';
 assert (select count(*)=1 from public.customer_opening_balances where customer_id='ef100000-0000-4000-8000-000000000003' and superseded_by is not null),'old row superseded';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000003')->>'overdue_over_90')::numeric=300,'debt over 90 days';
end $$;

-- ---------- bank statement ----------
do $$ declare r jsonb := pg_temp.ledger_fixture_bank('kl_to_1c.txt',pg_temp.sha('statement-1'),'KZ00FREEDOM',current_date-60,current_date-1,'KZT',
  jsonb_build_array(
    jsonb_build_object('doc_number','11','doc_date',current_date-45,'amount',999,'payer_bin','123456789012','payer_name','ТОО Дебитор','purpose','Оплата'),
    jsonb_build_object('doc_number','12','doc_date',current_date-20,'amount',400,'payer_bin','123456789012','payer_name','ТОО Дебитор','purpose','Оплата по договору Д-1'),
    jsonb_build_object('doc_number','13','doc_date',current_date-10,'amount',50,'payer_bin','777777777777','payer_name','ИП Неизвестный','purpose','Оплата за товар')));
begin
 assert (r->>'new')::int=3 and (r->>'matched')::int=2 and (r->>'duplicates')::int=0,'3 new, 2 matched by BIN: '||r::text;
end $$;
select pg_temp.fails($$select pg_temp.ledger_fixture_bank('again.txt',pg_temp.sha('statement-1'),'KZ00FREEDOM',null,null,'KZT','[]')$$,'уже загружена');
do $$ begin
 assert (select matched_how='auto_bin' and status='matched' from public.bank_statement_lines where doc_number='12'),'matched by BIN';
 assert (select status='unmatched' from public.bank_statement_lines where doc_number='13'),'unknown payer stays unmatched';
 -- The payment dated before the 1С balance date is already inside that balance.
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=1100,'1500 - 400 (999 is before the balance date)';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'overdue')::numeric=1100,'still overdue';
end $$;

-- ---------- warning before confirming an order ----------
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',false);
insert into rt select 'sale',public.create_customer_order('ef100000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date+5,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item',public.add_customer_order_item(pg_temp.id('sale'),'ef200000-0000-4000-8000-000000000001',10,'piece',100,null);
select public.reserve_customer_order_item_fefo(pg_temp.id('item'));
do $$ declare c jsonb := public.customer_credit_check(pg_temp.id('sale')); begin
 assert c->'issues'->0->>'code'='overdue' and (c->'issues'->0->>'amount')::numeric=1100,'the sales manager sees the overdue debt: '||c::text;
 assert (c->>'order_amount')::numeric=1000 and c->>'order_currency'='KZT','order amount';
end $$;
select pg_temp.fails($$select public.confirm_customer_order(pg_temp.id('sale'))$$,'риск по оплате: Просроченная задолженность 1 100,00 KZT, самая старая — 30 дн');
select pg_temp.fails($$select public.record_sale_credit_decision(pg_temp.id('sale'),'  ')$$,'Укажите, почему');
select public.record_sale_credit_decision(pg_temp.id('sale'),'Клиент обещал оплатить до конца недели, согласовано с директором');
select public.confirm_customer_order(pg_temp.id('sale'));
do $$ begin
 assert (select status='confirmed' from public.sales where id=pg_temp.id('sale')),'confirmed after the decision';
 assert (select count(*)=1 from public.sale_credit_decisions where sale_id=pg_temp.id('sale')),'decision recorded';
end $$;
select pg_temp.fails($$select public.record_sale_credit_decision(pg_temp.id('sale'),'ещё раз')$$,'до подтверждения');
reset role;
do $$ begin
 assert exists(select 1 from public.notifications where recipient_user_id='ef000000-0000-4000-8000-000000000003'
               and entity_type='sale' and entity_id=pg_temp.id('sale') and body like '%Причина: Клиент обещал%'),'the accountant is notified';
 assert not exists(select 1 from public.notifications where recipient_user_id='ef000000-0000-4000-8000-000000000002'
               and entity_id=pg_temp.id('sale')),'the author is not notified';
end $$;

-- Shipping the order: the shipment date is recorded and the debt is due after the contract's 30 days.
update public.inventory_balances b set quantity_on_hand=b.quantity_on_hand-r.quantity, quantity_reserved=b.quantity_reserved-r.quantity
from public.inventory_reservations r where r.inventory_balance_id=b.id and r.sale_item_id=pg_temp.id('item') and r.status='active';
update public.inventory_reservations set status='fulfilled' where sale_item_id=pg_temp.id('item') and status='active';
update public.sales set status='shipped' where id=pg_temp.id('sale');
do $$ begin assert (select shipped_at is not null from public.sales where id=pg_temp.id('sale')),'shipped_at is filled'; end $$;
set role authenticated;
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000003',false);
do $$ declare e jsonb; begin
 select x into e from jsonb_array_elements(public.customer_statement('ef100000-0000-4000-8000-000000000002')->'entries') x where x->>'kind'='shipment';
 assert (e->>'amount')::numeric=1000 and (e->>'due_date')::date=current_date+30,'shipment due after the contract deferral: '||e::text;
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'not_due')::numeric=1000,'not due yet';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=2100,'balance 2100';
end $$;

-- A payment by the order number from an unknown account, and an overlapping statement.
do $$ declare r jsonb := pg_temp.ledger_fixture_bank('kl_to_1c (2).txt',pg_temp.sha('statement-2'),'KZ00FREEDOM',current_date-30,current_date,'KZT',
  jsonb_build_array(
    jsonb_build_object('doc_number','12','doc_date',current_date-20,'amount',400,'payer_bin','123456789012','payer_name','ТОО Дебитор','purpose','Оплата по договору Д-1'),
    jsonb_build_object('doc_number','21','doc_date',current_date-1,'amount',1100,'payer_bin','999999999999','payer_name','ТОО Плательщик за третье лицо',
                       'purpose','Оплата по счёту '||lower((select sale_number from public.sales where id=pg_temp.id('sale')))||' за ТОО Дебитор')));
begin
 assert (r->>'new')::int=1 and (r->>'duplicates')::int=1 and (r->>'matched')::int=1,'the repeated payment is skipped: '||r::text;
end $$;
do $$ begin
 assert (select matched_how='auto_order' and sale_id=pg_temp.id('sale') and customer_id='ef100000-0000-4000-8000-000000000002'
         from public.bank_statement_lines where doc_number='21'),'matched by the order number';
 -- 400 + 1100 close the opening 1500 first (FIFO): nothing is overdue, the shipment is not due.
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'overdue')::numeric=0,'nothing overdue';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=1000,'balance 1000';
end $$;

-- Manual matching of the unknown payer.
select pg_temp.fails($$select public.resolve_bank_line((select id from public.bank_statement_lines where doc_number='13'),'match','ef100000-0000-4000-8000-000000000003',pg_temp.id('sale'),null)$$,'не относится к этому покупателю');
select public.resolve_bank_line((select id from public.bank_statement_lines where doc_number='13'),'match','ef100000-0000-4000-8000-000000000002',null,'Директор ИП — учредитель клиента');
do $$ begin assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=950,'manual match counts'; end $$;
select public.resolve_bank_line((select id from public.bank_statement_lines where doc_number='13'),'reset');
select pg_temp.fails($$select public.resolve_bank_line((select id from public.bank_statement_lines where doc_number='13'),'ignore')$$,'Укажите, почему');
select public.resolve_bank_line((select id from public.bank_statement_lines where doc_number='13'),'ignore',null,null,'Возврат подотчётных средств');
do $$ begin
 assert (select status='ignored' and customer_id is null from public.bank_statement_lines where doc_number='13'),'ignored';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=1000,'ignored payment does not count';
end $$;

-- ---------- a return and an adjustment reduce the debt ----------
reset role;
insert into public.user_roles(user_id,role_id) select 'ef000000-0000-4000-8000-000000000003',id from public.app_roles where code='director';
set role authenticated;
select public.create_customer_return(pg_temp.id('sale'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item'),'batch_id','ef300000-0000-4000-8000-000000000001','quantity',2)));
do $$ begin assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=800,'a return at the order price'; end $$;
select pg_temp.fails($$select public.add_customer_balance_adjustment('ef100000-0000-4000-8000-000000000002','KZT',current_date,-100,' ')$$,'причину');
select public.add_customer_balance_adjustment('ef100000-0000-4000-8000-000000000002','KZT',current_date,-100,'Ретро-бонус по акту');
do $$ begin assert (pg_temp.aging('ef100000-0000-4000-8000-000000000002')->>'balance')::numeric=700,'an adjustment'; end $$;

-- ---------- reconciliation act: the difference is shown, not corrected ----------
do $$ declare r jsonb := public.record_reconciliation_act('ef100000-0000-4000-8000-000000000002','KZT',current_date,750,'Акт подписан клиентом'); begin
 assert (r->>'nexus_balance')::numeric=700 and (r->>'difference')::numeric=50,'act vs Nexus: '||r::text;
end $$;
do $$ declare r jsonb := public.record_reconciliation_act('ef100000-0000-4000-8000-000000000002','KZT',current_date-15,1500,null); begin
 assert (r->>'nexus_balance')::numeric=1100 and (r->>'difference')::numeric=400,'balance on a past date: '||r::text;
end $$;

-- ---------- advance in another currency ----------
select pg_temp.ledger_fixture_bank('eur.txt',pg_temp.sha('statement-eur'),'KZ00FREEDOMEUR',null,null,'EUR',
  jsonb_build_array(jsonb_build_object('doc_number','1','doc_date',current_date,'amount',50,'payer_bin','210987654321','purpose','Предоплата')));
do $$ begin
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000003','EUR')->>'balance')::numeric=-50,'an advance';
 assert (pg_temp.aging('ef100000-0000-4000-8000-000000000003','KZT')->>'overdue_over_90')::numeric=300,'tenge debt untouched by euro';
end $$;

-- ---------- credit limit ----------
select pg_temp.fails($$select public.set_customer_credit_terms('ef100000-0000-4000-8000-000000000002',500,null,10)$$,'валюту кредитного');
select public.set_customer_credit_terms('ef100000-0000-4000-8000-000000000002',500,'kzt',10);
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000002',false);
insert into rt select 'sale2',public.create_customer_order('ef100000-0000-4000-8000-000000000002',null,pg_temp.id('warehouse'),current_date+5,(select id from public.currencies where code='KZT'),null);
insert into rt select 'item2',public.add_customer_order_item(pg_temp.id('sale2'),'ef200000-0000-4000-8000-000000000001',5,'piece',100,null);
select public.reserve_customer_order_item_fefo(pg_temp.id('item2'));
do $$ declare c jsonb := public.customer_credit_check(pg_temp.id('sale2')); begin
 assert jsonb_array_length(c->'issues')=1 and c->'issues'->0->>'code'='limit' and (c->'issues'->0->>'amount')::numeric=1200,'700 + 500 over the limit: '||c::text;
end $$;
select pg_temp.fails($$select public.confirm_customer_order(pg_temp.id('sale2'))$$,'Долг с этим заказом 1 200,00 KZT превысит кредитный лимит 500,00');
do $$ begin assert (select status='reserved' from public.sales where id=pg_temp.id('sale2')),'the order waits'; end $$;
-- The sales manager does not see the receivables tables themselves.
do $$ begin
 assert not exists(select 1 from public.bank_statement_lines),'no statement lines without receivables.view';
 assert not exists(select 1 from public.customer_opening_balances),'no balances without receivables.view';
 assert exists(select 1 from public.sale_credit_decisions),'but the decisions on orders are visible';
end $$;

-- ---------- the list ----------
select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false);
do $$ declare l jsonb := public.customer_receivables(); r jsonb; begin
 select x into r from jsonb_array_elements(l) x where x->>'customer_id'='ef100000-0000-4000-8000-000000000002';
 assert r->>'customer'='Дебитор' and (r->>'credit_limit')::numeric=500 and (r->>'deferral_days')::int=10,'terms in the list: '||r::text;
 assert (r->'last_act'->>'difference')::numeric=50,'latest act difference';
 assert exists(select 1 from jsonb_array_elements(l) x where x->>'customer_id'='ef100000-0000-4000-8000-000000000003'),'old debtor listed';
 assert not exists(select 1 from jsonb_array_elements(l) x where x->>'customer_id'='ef100000-0000-4000-8000-000000000001'),'supplier not listed';
end $$;
do $$ declare s jsonb := public.customer_statement('ef100000-0000-4000-8000-000000000002'); begin
 assert (select (x->>'running')::numeric from jsonb_array_elements(s->'entries') x order by (x->>'entry_date')::date desc, x->>'kind' desc limit 1) is not null,'running balance';
 assert (select count(*) from jsonb_array_elements(s->'entries') x where x->>'kind'='payment')=2,'the payment before the balance date is not in the statement';
end $$;

reset role;
rollback;
