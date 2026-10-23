-- Audit findings Н3 and Н4: items without a receipt, planned versus actual expenses, cancellation and reversal.
-- supabase/tests/before/202609278000_expense_cancel_costing.sql shows the same scenarios failing before the fix.
\set ON_ERROR_STOP 1
begin;

insert into auth.users(id,email,raw_user_meta_data) values
 ('ec000000-0000-4000-8000-000000000001','cost-director@test.local','{"full_name":"Cost Director"}'),
 ('ec000000-0000-4000-8000-000000000002','cost-accountant@test.local','{"full_name":"Cost Accountant"}'),
 ('ec000000-0000-4000-8000-000000000003','cost-logistic@test.local','{"full_name":"Cost Logistic"}'),
 ('ec000000-0000-4000-8000-000000000004','cost-no-prices@test.local','{"full_name":"Cost Without Prices"}'),
 ('ec000000-0000-4000-8000-000000000005','cost-no-payments@test.local','{"full_name":"Cost Without Payments"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values('ec000000-0000-4000-8000-000000000001','director'),('ec000000-0000-4000-8000-000000000002','accountant'),
 ('ec000000-0000-4000-8000-000000000003','logistics_specialist'),('ec000000-0000-4000-8000-000000000004','accountant'),
 ('ec000000-0000-4000-8000-000000000005','accountant'))u(id,code)
join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select u.id::uuid,p.id,'deny','cost test','ec000000-0000-4000-8000-000000000001'
from (values('ec000000-0000-4000-8000-000000000004','prices.purchase.view'),('ec000000-0000-4000-8000-000000000005','finance.pay'))u(id,code)
join public.permissions p on p.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ec100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Cost supplier','FI','EC-SUP'),
 ('ec100000-0000-4000-8000-000000000002',array['carrier'],'Cost carrier','KZ','EC-CAR');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ec200000-0000-4000-8000-000000000001','EC-A','{"ru":"Товар А"}','ec100000-0000-4000-8000-000000000001','active'),
 ('ec200000-0000-4000-8000-000000000002','EC-B','{"ru":"Товар Б"}','ec100000-0000-4000-8000-000000000001','active');
-- Only product A has a weight: product B must not be needed for allocation when it did not arrive.
insert into public.product_packaging(product_id,uom,units_per_parent,gross_weight_kg) values('ec200000-0000-4000-8000-000000000001','piece',1,1.5);
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select s.id::uuid,s.number,'import','ec100000-0000-4000-8000-000000000001',(select id from public.routes limit 1),
 (select id from public.process_templates where code='import_eu_kz' and version=1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where status='active' and not is_virtual limit 1),'ec000000-0000-4000-8000-000000000003','ec000000-0000-4000-8000-000000000001'
from (values('ec300000-0000-4000-8000-000000000001','EC-1'),('ec300000-0000-4000-8000-000000000002','EC-2'),
 ('ec300000-0000-4000-8000-000000000003','EC-3'),('ec300000-0000-4000-8000-000000000004','EC-4'))s(id,number);
-- EC-1: A arrived, B (no price, no weight) did not arrive. EC-2: nothing arrived. EC-3: A arrived.
-- EC-4: not received yet; quantities come from the order.
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,received_quantity,unit_price,currency_id)
select i.id::uuid,i.shipment::uuid,i.product::uuid,'piece',i.ordered,i.received,i.price,(select id from public.currencies where code='EUR') from (values
 ('ec400000-0000-4000-8000-000000000001','ec300000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000001',10,10,2.0),
 ('ec400000-0000-4000-8000-000000000002','ec300000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000002',10,0,null),
 ('ec400000-0000-4000-8000-000000000003','ec300000-0000-4000-8000-000000000002','ec200000-0000-4000-8000-000000000001',10,0,2.0),
 ('ec400000-0000-4000-8000-000000000004','ec300000-0000-4000-8000-000000000003','ec200000-0000-4000-8000-000000000001',10,10,2.0),
 ('ec400000-0000-4000-8000-000000000005','ec300000-0000-4000-8000-000000000004','ec200000-0000-4000-8000-000000000001',10,null,2.0),
 ('ec400000-0000-4000-8000-000000000006','ec300000-0000-4000-8000-000000000004','ec200000-0000-4000-8000-000000000002',5,null,2.0))i(id,shipment,product,ordered,received,price);
insert into public.inventory_batches(id,product_id,source_shipment_item_id,batch_number,expiry_date,created_by) values
 ('ec500000-0000-4000-8000-000000000001','ec200000-0000-4000-8000-000000000001','ec400000-0000-4000-8000-000000000004','EC-LOT-3','2027-12-31','ec000000-0000-4000-8000-000000000001');

create function pg_temp.expect_failure(p_sql text,p_expected text) returns void language plpgsql as $$
begin
 execute p_sql;
 raise exception 'expected a failure: %',p_sql using errcode='P0099';
exception when sqlstate 'P0099' then raise;
 when others then
  if position(p_expected in sqlerrm)=0 and sqlstate<>p_expected then raise exception 'unexpected error for %: % (%)',p_sql,sqlerrm,sqlstate;end if;
end $$;
create function pg_temp.kzt() returns uuid language sql stable as $$select id from public.currencies where code='KZT'$$;
create function pg_temp.expense(p_note text) returns uuid language sql stable as $$select id from public.expenses where notes=p_note$$;
create function pg_temp.calculate(p_shipment uuid) returns uuid language sql as $$select public.calculate_shipment_cost(p_shipment,pg_temp.kzt())$$;

-- Explicit declaration fixture: foreign purchase costs require a confirmed declaration.
with inserted as (
 insert into public.documents(document_type_id,title,document_number,document_date,status,uploaded_by)
 select dt.id,'Cost declaration '||s.shipment_number,s.shipment_number,(now() at time zone 'Asia/Almaty')::date,'approved',s.created_by
 from public.shipments s cross join public.document_types dt where dt.code='customs_declaration' and s.id::text like 'ec%'
 returning id,document_number
) insert into public.document_links(document_id,entity_type,entity_id,created_by)
 select d.id,'shipment',s.id,s.created_by from inserted d join public.shipments s on s.shipment_number=d.document_number;

set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.add_exchange_rate((select id from public.currencies where code='EUR'),pg_temp.kzt(),500,'official','Тест',current_date);

-- 1. Н3: an item without a receipt is left out. EC-1 is calculated without any expense first: no division by zero.
select pg_temp.calculate('ec300000-0000-4000-8000-000000000001');
do $$begin
 assert (select count(*)=1 and min(quantity)=10 and sum(goods_amount)=10000 and sum(allocated_expenses)=0 from public.cost_calculation_items i
  join public.cost_calculations c on c.id=i.calculation_id where c.shipment_id='ec300000-0000-4000-8000-000000000001'),
  'the calculation holds only the received product A: 10 x 2 EUR x 500';
 assert (select planned_expenses_total is null and planned_expenses_without_rate=0 and inputs_digest is not null
  from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000001'),'no plan, and the inputs are remembered';
end$$;
select public.create_expense('ec300000-0000-4000-8000-000000000001','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-1 перевозка');
select public.confirm_expense(pg_temp.expense('EC-1 перевозка'));
-- By weight and by value product B (no weight, no price) does not block: it received nothing.
select public.allocate_expense(pg_temp.expense('EC-1 перевозка'),m,pg_temp.kzt()) from unnest(array['by_weight','by_value','by_quantity'])m;
do $$begin
 assert (select count(*)=1 and min(shipment_item_id::text)='ec400000-0000-4000-8000-000000000001' and sum(allocated_amount)=50000
  from public.expense_allocations where expense_id=(select id from public.expenses where notes='EC-1 перевозка')),
  'the whole transport goes to the received product A';
end$$;
select pg_temp.calculate('ec300000-0000-4000-8000-000000000001');
do $$begin
 assert (select goods_total=10000 and expenses_total=50000 and landed_total=60000 from public.cost_calculations
  where shipment_id='ec300000-0000-4000-8000-000000000001' and version_number=2),'landed cost of EC-1';
 assert (select unit_landed_cost=6000 from public.cost_calculation_items where shipment_item_id='ec400000-0000-4000-8000-000000000001'
  and calculation_id=(select id from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000001' and version_number=2)),'unit cost of product A';
end$$;
-- Allocating the expense again after the calculation makes that version stale.
select public.allocate_expense(pg_temp.expense('EC-1 перевозка'),'by_weight',pg_temp.kzt());
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.approve_shipment_cost(%L)',(select id from public.cost_calculations
 where shipment_id='ec300000-0000-4000-8000-000000000001' and version_number=2)),'После расчёта изменились расходы или позиции поставки');
-- A received item still needs its weight, and the message names it.
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.create_expense('ec300000-0000-4000-8000-000000000004','transport','ec100000-0000-4000-8000-000000000002',150,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-4 перевозка');
select public.confirm_expense(pg_temp.expense('EC-4 перевозка'));
select pg_temp.expect_failure(format('select public.allocate_expense(%L,%L,%L)',pg_temp.expense('EC-4 перевозка'),'by_weight',pg_temp.kzt()),
 'не хватает цены, веса или объёма у позиций: EC-B');

-- 2. EC-2: nothing arrived. Neither allocation nor calculation has anything to work with, and both say so.
select pg_temp.expect_failure($q$select pg_temp.calculate('ec300000-0000-4000-8000-000000000002')$q$,'В поставке нет принятого товара');
select public.create_expense('ec300000-0000-4000-8000-000000000002','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-2 перевозка');
select public.confirm_expense(pg_temp.expense('EC-2 перевозка'));
select pg_temp.expect_failure(format('select public.allocate_expense(%L,%L,%L)',pg_temp.expense('EC-2 перевозка'),'by_quantity',pg_temp.kzt()),
 'В поставке нет принятого товара');

-- 3. Н4: only actual expenses form the landed cost; planned ones are kept for comparison.
select public.create_expense('ec300000-0000-4000-8000-000000000003','transport','ec100000-0000-4000-8000-000000000002',100,
 (select id from public.currencies where code='EUR'),current_date,true,null,'EC-3 план перевозки');
select public.create_expense('ec300000-0000-4000-8000-000000000003','customs_duty',null,1000,
 (select id from public.currencies where code='RUB'),current_date,true,null,'EC-3 план без курса');
select public.create_expense('ec300000-0000-4000-8000-000000000003','goods_cost',null,30,
 (select id from public.currencies where code='EUR'),current_date,true,null,'EC-3 план товара');
select public.create_expense('ec300000-0000-4000-8000-000000000003','transport','ec100000-0000-4000-8000-000000000002',120,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-3 факт перевозки');
select public.confirm_expense(pg_temp.expense('EC-3 план перевозки'));
select public.confirm_expense(pg_temp.expense('EC-3 факт перевозки'));
select pg_temp.expect_failure(format('select public.allocate_expense(%L,%L,%L)',pg_temp.expense('EC-3 план перевозки'),'by_quantity',pg_temp.kzt()),
 'Плановый расход не распределяется');
-- A planned expense allocated before this change (the old functions allowed it) is still not counted.
reset role;
insert into public.expense_allocations(expense_id,shipment_item_id,allocation_method,allocation_basis,allocation_share,allocated_amount,currency_id,created_by)
select id,'ec400000-0000-4000-8000-000000000004','by_quantity',10,1,50000,pg_temp.kzt(),'ec000000-0000-4000-8000-000000000002' from public.expenses where notes='EC-3 план перевозки';
update public.expenses set status='allocated' where notes='EC-3 план перевозки';
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.allocate_expense(pg_temp.expense('EC-3 факт перевозки'),'by_quantity',pg_temp.kzt());
-- Two planned expenses stay a draft and a confirmed one: neither blocks the calculation.
select pg_temp.calculate('ec300000-0000-4000-8000-000000000003');
do $$begin
 assert (select goods_total=10000 and expenses_total=60000 and landed_total=70000 and planned_expenses_total=50000 and planned_expenses_without_rate=1
  from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000003' and version_number=1),
  'fact 120 EUR = 60,000 KZT; plan 100 EUR = 50,000 KZT; the RUB plan has no rate; the planned goods cost is not an expense';
end$$;

-- 4. Cancellation before payment, always with a reason.
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000003',false);
select public.create_expense('ec300000-0000-4000-8000-000000000003','transport','ec100000-0000-4000-8000-000000000002',120,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-3 ошибочный повтор');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.create_expense('ec300000-0000-4000-8000-000000000002','other',null,5,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-2 черновик бухгалтера');
select pg_temp.expect_failure($q$select pg_temp.calculate('ec300000-0000-4000-8000-000000000003')$q$,
 'Подтвердите и распределите фактические расходы поставки или отмените ошибочные');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000003',false);
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',pg_temp.expense('EC-3 ошибочный повтор'),'   '),'Укажите причину отмены');
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',pg_temp.expense('EC-3 ошибочный повтор'),repeat('я',501)),'длиннее 500 символов');
-- A logistician cancels only their own draft: not a confirmed expense and not someone else's draft.
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',pg_temp.expense('EC-3 факт перевозки'),'Не моё'),'42501');
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',pg_temp.expense('EC-2 черновик бухгалтера'),'Не моё'),'42501');
select public.cancel_expense(pg_temp.expense('EC-3 ошибочный повтор'),'  Внесён дважды  ');
do $$begin
 assert (select status='cancelled' and cancelled_by='ec000000-0000-4000-8000-000000000003' and cancelled_at is not null and cancellation_reason='Внесён дважды'
  from public.expenses where notes='EC-3 ошибочный повтор'),'the draft is cancelled with the trimmed reason and the author';
end$$;
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',pg_temp.expense('EC-3 ошибочный повтор'),'Ещё раз'),'уже отменён');
select pg_temp.expect_failure(format('select public.confirm_expense(%L)',pg_temp.expense('EC-3 ошибочный повтор')),'Нет права');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select pg_temp.expect_failure(format('select public.confirm_expense(%L)',pg_temp.expense('EC-3 ошибочный повтор')),'Подтвердить можно только черновик');
select pg_temp.expect_failure(format('select public.allocate_expense(%L,%L,%L)',pg_temp.expense('EC-3 ошибочный повтор'),'by_quantity',pg_temp.kzt()),
 'Сначала подтвердите расход');
select pg_temp.calculate('ec300000-0000-4000-8000-000000000003');
do $$begin
 assert (select expenses_total=60000 and planned_expenses_total=50000 from public.cost_calculations
  where shipment_id='ec300000-0000-4000-8000-000000000003' and version_number=2),'the cancelled draft is ignored';
end$$;

-- 5. A calculation is approved only while its inputs are unchanged. finance.manage cancels an allocated expense.
select public.cancel_expense(pg_temp.expense('EC-3 факт перевозки'),'Счёт выставлен другой поставке');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.approve_shipment_cost(%L)',(select id from public.cost_calculations
 where shipment_id='ec300000-0000-4000-8000-000000000003' and version_number=2)),'После расчёта изменились расходы или позиции поставки');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.cancel_expense(pg_temp.expense('EC-3 план без курса'),'Пошлину не планируем');
select pg_temp.calculate('ec300000-0000-4000-8000-000000000003');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select public.approve_shipment_cost((select id from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000003' and version_number=3));
do $$begin
 assert (select status='approved' and expenses_total=0 and landed_total=10000 and planned_expenses_total=50000 and planned_expenses_without_rate=0
  from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000003' and version_number=3),
  'the fresh version without the cancelled expenses (actual and planned) is approved';
 assert (select unit_landed_cost=1000 from public.my_inventory_batch_costs('ec200000-0000-4000-8000-000000000001')
  where batch_id='ec500000-0000-4000-8000-000000000001'),'and its unit cost reaches the batch';
 assert (select count(*)=1 from public.expense_allocations where expense_id=(select id from public.expenses where notes='EC-3 факт перевозки')),
  'allocations of the cancelled expense stay as history';
end$$;

-- 6. A paid expense is not cancelled but reversed (storno), by finance.manage together with finance.pay.
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.mark_expense_paid(pg_temp.expense('EC-1 перевозка'));
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',pg_temp.expense('EC-1 перевозка'),'Ошибка'),'оформите сторнирование');
select pg_temp.expect_failure(format('select public.reverse_expense(%L,%L)',pg_temp.expense('EC-4 перевозка'),'Ошибка'),'Сторнировать можно только оплаченный расход');
select pg_temp.expect_failure(format('select public.reverse_expense(%L,%L)',pg_temp.expense('EC-1 перевозка'),''),'Укажите причину сторнирования');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000003',false);
select pg_temp.expect_failure(format('select public.reverse_expense(%L,%L)',pg_temp.expense('EC-1 перевозка'),'Ошибка'),'42501');
-- finance.manage alone is not enough: this accountant has a personal deny of finance.pay.
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000005',false);
select pg_temp.expect_failure(format('select public.reverse_expense(%L,%L)',pg_temp.expense('EC-1 перевозка'),'Ошибка'),'42501');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select public.reverse_expense(pg_temp.expense('EC-1 перевозка'),'Перевозчик вернул оплату');
do $$begin
 assert (select status='reversed' and paid_at is not null and paid_by='ec000000-0000-4000-8000-000000000002' and reversed_by='ec000000-0000-4000-8000-000000000002'
  and reversed_at is not null and reversal_reason='Перевозчик вернул оплату' and cancelled_at is null
  from public.expenses where notes='EC-1 перевозка'),'the payment history stays and the reversal is recorded';
end$$;
select pg_temp.expect_failure(format('select public.reverse_expense(%L,%L)',pg_temp.expense('EC-1 перевозка'),'Ещё раз'),'уже отменён или сторнирован');
select pg_temp.expect_failure(format('select public.mark_expense_paid(%L)',pg_temp.expense('EC-1 перевозка')),'Оплатить можно только распределённый расход');
select pg_temp.calculate('ec300000-0000-4000-8000-000000000001');
do $$begin
 assert (select expenses_total=0 from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000001' and version_number=3),
  'the reversed expense leaves the landed cost';
end$$;

-- 7. An expense spread before the receipt over an item that then did not arrive has to be allocated again,
--    and a paid expense may be re-allocated without losing its payment.
select public.allocate_expense(pg_temp.expense('EC-4 перевозка'),'by_quantity',pg_temp.kzt());
select public.mark_expense_paid(pg_temp.expense('EC-4 перевозка'));
reset role;
update public.shipment_items set received_quantity=case id when 'ec400000-0000-4000-8000-000000000005' then 10 else 0 end
where shipment_id='ec300000-0000-4000-8000-000000000004';
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select pg_temp.expect_failure($q$select pg_temp.calculate('ec300000-0000-4000-8000-000000000004')$q$,'распределена на позиции без прихода (EC-B)');
select public.allocate_expense(pg_temp.expense('EC-4 перевозка'),'by_quantity',pg_temp.kzt());
do $$begin
 assert (select status='paid' and paid_at is not null from public.expenses where notes='EC-4 перевозка'),'re-allocation keeps the payment';
 assert (select count(*)=1 and sum(allocated_amount)=75000 from public.expense_allocations where expense_id=(select id from public.expenses where notes='EC-4 перевозка')),
  '150 EUR now goes to the received product A only';
end$$;
select pg_temp.calculate('ec300000-0000-4000-8000-000000000004');
do $$begin
 assert (select expenses_total=75000 and goods_total=10000 from public.cost_calculations where shipment_id='ec300000-0000-4000-8000-000000000004'),'EC-4 is calculated';
end$$;

-- 8. A draft calculated by the previous rules cannot be approved; changed quantities also make a draft stale.
reset role;
update public.cost_calculations set inputs_digest=null where shipment_id='ec300000-0000-4000-8000-000000000001' and version_number=3;
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.approve_shipment_cost(%L)',(select id from public.cost_calculations
 where shipment_id='ec300000-0000-4000-8000-000000000001' and version_number=3)),'Расчёт сделан по прежним правилам');
reset role;
update public.shipment_items set received_quantity=9 where id='ec400000-0000-4000-8000-000000000005';
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.approve_shipment_cost(%L)',(select id from public.cost_calculations
 where shipment_id='ec300000-0000-4000-8000-000000000004')),'После расчёта изменились расходы или позиции поставки');
-- A new actual expense entered after the calculation makes it stale as well.
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000002',false);
select pg_temp.calculate('ec300000-0000-4000-8000-000000000004');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000003',false);
select public.create_expense('ec300000-0000-4000-8000-000000000004','other',null,1,
 (select id from public.currencies where code='EUR'),current_date,false,null,'EC-4 новый черновик');
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000001',false);
select pg_temp.expect_failure(format('select public.approve_shipment_cost(%L)',(select id from public.cost_calculations
 where shipment_id='ec300000-0000-4000-8000-000000000004' and version_number=2)),'После расчёта изменились расходы или позиции поставки');

-- 9. Goods cost stays behind the purchase-price permission, also for cancellation and reversal
--    (the user cannot even read the row, so its id is taken as the table owner).
reset role;
select set_config('ec.goods_cost',(select id::text from public.expenses where notes='EC-3 план товара'),false);
set role authenticated;
select set_config('request.jwt.claim.sub','ec000000-0000-4000-8000-000000000004',false);
select pg_temp.expect_failure(format('select public.cancel_expense(%L,%L)',current_setting('ec.goods_cost'),'Ошибка'),'42501');
reset role;
update public.expenses set status='paid',paid_by='ec000000-0000-4000-8000-000000000002',paid_at=now() where notes='EC-3 план товара';
set role authenticated;
select pg_temp.expect_failure(format('select public.reverse_expense(%L,%L)',current_setting('ec.goods_cost'),'Ошибка'),'42501');
do $$begin
 assert (select status='paid' from public.expenses where notes='EC-3 план товара') is null,'the row itself stays hidden from this user';
end$$;

-- 10. Statuses change only through the functions, and the table refuses a cancellation without its record.
reset role;
do $$begin
 assert not has_table_privilege('authenticated','public.expenses','update') and not has_table_privilege('authenticated','public.expenses','delete'),
  'no direct changes of expenses';
 assert not has_function_privilege('anon','public.cancel_expense(uuid,text)','execute') and not has_function_privilege('anon','public.reverse_expense(uuid,text)','execute'),
  'anonymous callers cannot cancel or reverse';
 assert not has_function_privilege('authenticated','private.shipment_cost_inputs_digest(uuid)','execute'),'the digest is internal';
 begin
  update public.expenses set status='cancelled' where notes='EC-4 перевозка';
  raise exception 'cancelled without a reason' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when check_violation then null;
 end;
 begin
  update public.expenses set status='reversed',reversed_at=now(),reversed_by='ec000000-0000-4000-8000-000000000002',reversal_reason='x' where notes='EC-2 перевозка';
  raise exception 'reversed without a payment' using errcode='P0099';
 exception when sqlstate 'P0099' then raise; when check_violation then null;
 end;
end$$;

rollback;
