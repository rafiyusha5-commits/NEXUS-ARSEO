-- Runs on the schema BEFORE 202609278000_expense_cancel_costing.sql and proves the defects it fixes.
-- Everything is rolled back. supabase/tests/expense_cancel_costing.test.sql proves they are closed afterwards.
--   Н3. An item that did not arrive (received 0) makes every expense of the shipment unallocatable, the
--       unallocated expense blocks the calculation, and without expenses the calculation divides by zero.
--   Н4. A planned and an actual expense for the same transport are added together, and an expense
--       entered by mistake cannot be cancelled: as a draft it blocks the calculation for good.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ec000000-0000-4000-8000-000000000001','cost-before-director@test.local','{"full_name":"Cost Before Director"}'),
 ('ec000000-0000-4000-8000-000000000002','cost-before-accountant@test.local','{"full_name":"Cost Before Accountant"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values('ec000000-0000-4000-8000-000000000001','director'),('ec000000-0000-4000-8000-000000000002','accountant'))u(id,code)
join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ec100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Cost before supplier','FI','ECB-SUP'),
 ('ec100000-0000-4000-8000-000000000002',array['carrier'],'Cost before carrier','KZ','ECB-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ec200000-0000-4000-8000-000000000001','ECB-A','{"ru":"Товар А"}','ec100000-0000-4000-8000-000000000001','active'),
 ('ec200000-0000-4000-8000-000000000002','ECB-B','{"ru":"Товар Б"}','ec100000-0000-4000-8000-000000000001','active');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.number,'import','ec100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),
 (select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual limit 1),'ec000000-0000-4000-8000-000000000001','ec000000-0000-4000-8000-000000000001'
from (values('ec300000-0000-4000-8000-000000000001','ECB-1'),('ec300000-0000-4000-8000-000000000002','ECB-2'),('ec300000-0000-4000-8000-000000000003','ECB-3'))s(id,number);
-- ECB-1 and ECB-2: product A arrived in full, product B did not arrive at all. ECB-3: both arrived.
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id)
select i.id::uuid,i.shipment::uuid,i.product::uuid,'piece',10,i.received,2,(select id from public.currencies where code='EUR') from (values
 ('ec400000-0000-4000-8000-000000000001','ec300000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000001',10),
 ('ec400000-0000-4000-8000-000000000002','ec300000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000002',0),
 ('ec400000-0000-4000-8000-000000000003','ec300000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000001',10),
 ('ec400000-0000-4000-8000-000000000004','ec300000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000002',0),
 ('ec400000-0000-4000-8000-000000000005','ec300000-0000-4000-8000-000000000003','ec200000-0000-4000-8000-000000000001',10),
 ('ec400000-0000-4000-8000-000000000006','ec300000-0000-4000-8000-000000000003','ec200000-0000-4000-8000-000000000002',10))i(id,shipment,product,received);

create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
 execute p_sql;
 raise exception 'expected a failure: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;
 when others then
  if position(p_expected in sqlerrm)=0 and sqlstate<>p_expected then raise exception 'unexpected error for %: % (%)',p_sql,sqlerrm,sqlstate;end if;
end $$;

set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.add_exchange_rate((select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official','Тест',current_date);

-- Н3. ECB-1: the transport cannot be allocated by any method because product B received nothing.
select public.create_expense('ec300000-0000-4000-8000-000000000001','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,false,null,'Перевозка');
select public.confirm_expense((select id from public.expenses where shipment_id='ec300000-0000-4000-8000-000000000001'));
select pg_temp.expect_failure(format('select public.allocate_expense(%L,%L,%L)',(select id from public.expenses where shipment_id='ec300000-0000-4000-8000-000000000001'),
 m,(select id from public.currencies where code='KZT')),'не хватает цены, веса или объёма') from unnest(array['by_quantity','by_value','by_weight','by_volume'])m;
select pg_temp.expect_failure(format('select public.calculate_shipment_cost(%L,%L)','ec300000-0000-4000-8000-000000000001',(select id from public.currencies where code='KZT')),
 'Подтвердите и распределите все расходы поставки');
-- ECB-2 has no expenses at all: the unit cost of product B is computed as a division by zero.
select pg_temp.expect_failure(format('select public.calculate_shipment_cost(%L,%L)','ec300000-0000-4000-8000-000000000002',(select id from public.currencies where code='KZT')),'22012');

-- Н4. ECB-3: the planned estimate and the actual invoice of the same transport are both counted.
select public.create_expense('ec300000-0000-4000-8000-000000000003','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,true,null,'План');
select public.create_expense('ec300000-0000-4000-8000-000000000003','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,false,null,'Факт');
select public.confirm_expense(id) from public.expenses where shipment_id='ec300000-0000-4000-8000-000000000003';
select public.allocate_expense(id,'by_quantity',(select id from public.currencies where code='KZT'))
from public.expenses where shipment_id='ec300000-0000-4000-8000-000000000003';
select public.calculate_shipment_cost('ec300000-0000-4000-8000-000000000003',(select id from public.currencies where code='KZT'));
do $$begin
 assert (select expenses_total=100000 from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000003'),
  'before the fix 100 EUR planned plus 100 EUR actual make 100,000 KZT of expenses instead of 50,000';
end$$;
-- A mistaken draft cannot be cancelled or edited, and it blocks every further calculation.
select public.create_expense('ec300000-0000-4000-8000-000000000003','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,false,null,'Ошибочный повтор');
do $$begin
 assert to_regprocedure('public.cancel_expense(uuid,text)') is null,'before the fix there is no way to cancel an expense';
 assert not has_table_privilege('authenticated','public.expenses','update') and not has_table_privilege('authenticated','public.expenses','delete'),
  'and expenses cannot be changed directly';
end$$;
select pg_temp.expect_failure(format('select public.calculate_shipment_cost(%L,%L)','ec300000-0000-4000-8000-000000000003',(select id from public.currencies where code='KZT')),
 'Подтвердите и распределите все расходы поставки');

reset role;
rollback;
