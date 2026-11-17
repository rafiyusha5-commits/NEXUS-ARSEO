-- 202611170300: margin of every batch at the price-list and the customer's price, thresholds, "Проверьте цену".
-- Real path for the cost: shipment, two vehicles, two batches, receiving, calculation, approval. Synthetic data only.
-- Hand calculations next to every check. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('d3000000-0000-4000-8000-000000000001','margin-director@example.invalid','{"full_name":"Margin director"}'),
 ('d3000000-0000-4000-8000-000000000002','margin-admin@example.invalid','{"full_name":"Margin administrator"}'),
 ('d3000000-0000-4000-8000-000000000003','margin-denied@example.invalid','{"full_name":"Administrator without threshold right"}'),
 ('d3000000-0000-4000-8000-000000000004','margin-sales@example.invalid','{"full_name":"Sales without purchase prices"}'),
 ('d3000000-0000-4000-8000-000000000005','margin-commercial@example.invalid','{"full_name":"Commercial director"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('d3000000-0000-4000-8000-000000000001'::uuid,'director'),
 ('d3000000-0000-4000-8000-000000000002'::uuid,'administrator'),
 ('d3000000-0000-4000-8000-000000000003'::uuid,'administrator'),
 ('d3000000-0000-4000-8000-000000000004'::uuid,'logistics_specialist'),
 ('d3000000-0000-4000-8000-000000000005'::uuid,'commercial_director')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'd3000000-0000-4000-8000-000000000003',id,'deny','Personal deny of thresholds','d3000000-0000-4000-8000-000000000002'
 from public.permissions where code='pricing.margin_threshold.manage';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('d3100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Margin supplier','FI','D3-SUP'),
 ('d3100000-0000-4000-8000-000000000011',array['customer'],'Клиент со скидкой','KZ','D3-C1'),
 ('d3100000-0000-4000-8000-000000000012',array['customer'],'Клиент без скидки','KZ','D3-C2'),
 ('d3100000-0000-4000-8000-000000000013',array['customer'],'Клиент с фиксированной ценой','KZ','D3-C3'),
 ('d3100000-0000-4000-8000-000000000014',array['customer'],'Клиент без порога','KZ','D3-C4');
insert into public.products(id,internal_sku,name,manufacturer_id,brand,status) values
 ('d3200000-0000-4000-8000-000000000001','D3-A','{"ru":"Товар двух партий"}','d3100000-0000-4000-8000-000000000001','D3 Brand','active');
insert into public.brands(id,name,brand_key,created_by) values
 ('d3400000-0000-4000-8000-000000000001','D3 Brand',private.brand_key('D3 Brand'),'d3000000-0000-4000-8000-000000000002');
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official',current_date-1,
 'd3000000-0000-4000-8000-000000000001';
-- Price list: 8400 KZT per piece with VAT. Conditions: C1 -10 %, C2 0 %, C3 fixed 7000, C4 0 % and no threshold.
insert into public.price_list_entries(price_type_id,product_id,price,valid_from,origin,reason,created_by)
 select id,'d3200000-0000-4000-8000-000000000001',8400,'2020-01-01','manual','Синтетическая цена','d3000000-0000-4000-8000-000000000002'
 from public.price_types where code='kz_prepayment';
insert into public.customer_price_terms(customer_id,price_type_id,contract_currency_id,valid_from,reason,created_by)
 select c.id,(select id from public.price_types where code='kz_prepayment'),(select id from public.currencies where code='KZT'),'2020-01-01','Договор','d3000000-0000-4000-8000-000000000002'
 from public.counterparties c where c.tax_id in ('D3-C1','D3-C2','D3-C3','D3-C4');
insert into public.customer_brand_markups(customer_id,brand_id,percent,valid_from,reason,created_by) values
 ('d3100000-0000-4000-8000-000000000011','d3400000-0000-4000-8000-000000000001',-10,'2020-01-01','Скидка','d3000000-0000-4000-8000-000000000002'),
 ('d3100000-0000-4000-8000-000000000012','d3400000-0000-4000-8000-000000000001',0,'2020-01-01','Без скидки','d3000000-0000-4000-8000-000000000002'),
 ('d3100000-0000-4000-8000-000000000014','d3400000-0000-4000-8000-000000000001',0,'2020-01-01','Без скидки','d3000000-0000-4000-8000-000000000002');
insert into public.customer_fixed_prices(customer_id,product_id,price,currency_id,valid_from,reason,created_by)
 select 'd3100000-0000-4000-8000-000000000013','d3200000-0000-4000-8000-000000000001',7000,id,'2020-01-01','Спеццена','d3000000-0000-4000-8000-000000000002'
 from public.currencies where code='KZT';

create temporary table d3(k text primary key,id uuid);
grant all on d3 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from d3 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.batch(p_number text) returns public.inventory_batches language sql stable security definer as $$
 select * from public.inventory_batches where batch_number=p_number $$;
create function pg_temp.alerts() returns bigint language sql stable security definer as $$
 select count(*) from public.notifications where type='price_review' and entity_id='d3200000-0000-4000-8000-000000000001'
 and recipient_user_id in ('d3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000003') $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- Two vehicles of one shipment, two batches: LOT-A 10 EUR and LOT-B 12 EUR per piece, received, not yet approved.
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare v_ship uuid;v_t1 uuid;v_t2 uuid;v_i1 uuid;v_i2 uuid;
begin
 v_ship:=public.create_shipment_with_stages('D3-SHIP','import','d3100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),
  (select id from public.warehouses where status='active' and not is_virtual order by code limit 1),auth.uid(),current_date,current_date+14);
 perform public.add_shipment_transport(v_ship,null,null,null,null);perform public.add_shipment_transport(v_ship,null,null,null,null);
 select id into v_t1 from public.shipment_transports where shipment_id=v_ship and sequence_no=1;
 select id into v_t2 from public.shipment_transports where shipment_id=v_ship and sequence_no=2;
 v_i1:=public.allocate_shipment_item(public.create_shipment_item(v_ship,'d3200000-0000-4000-8000-000000000001','piece',100,10,pg_temp.cur('EUR')),v_t1,100);
 v_i2:=public.allocate_shipment_item(public.create_shipment_item(v_ship,'d3200000-0000-4000-8000-000000000001','piece',100,12,pg_temp.cur('EUR')),v_t2,100);
 insert into d3 values('ship',v_ship);
 perform public.change_shipment_transport_status(v_t1,'arrived');
 perform public.receive_shipment_transport(v_t1,null,jsonb_build_array(jsonb_build_object('item_id',v_i1,'accepted_quantity',100,'batch_number','D3-LOT-A','expiry_date',(current_date+200)::text)),'Кладовщик',null);
 perform public.change_shipment_transport_status(v_t2,'arrived');
 perform public.receive_shipment_transport(v_t2,null,jsonb_build_array(jsonb_build_object('item_id',v_i2,'accepted_quantity',100,'batch_number','D3-LOT-B','expiry_date',(current_date+300)::text)),'Кладовщик',null);
end $$;
reset role;

-- 1. Thresholds: only with the right and purchase prices; personal deny wins; history keeps previous values.
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000005',true);
set local role authenticated;
select pg_temp.fails($q$select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000011',15,'Попытка')$q$,'Нет права изменять порог');
reset role;
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000003',true);
set local role authenticated;
select pg_temp.fails($q$select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000011',15,'Попытка')$q$,'Нет права изменять порог');
reset role;
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000011',150,'Слишком много')$q$,'от -100 до 100');
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000011',12,'Первое значение');
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000011',15,'Согласовано с отделом продаж');
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000012',25,'Согласовано');
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000013',10,'Согласовано');
-- C4: zero is a value, then removed: no threshold, no check.
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000014',0,'Ноль — это значение');
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000014',null,'Порог снят');
do $$declare o jsonb;begin
 o:=public.customer_margin_overview('d3100000-0000-4000-8000-000000000011');
 assert o->>'threshold'='15.00' and jsonb_array_length(o->'history')=2
   and o->'history'->0->>'threshold'='15.00' and o->'history'->0->>'previous'='12.00' and o->'history'->0->>'author'='Margin administrator',
   'history: who, when, previous and new value';
 o:=public.customer_margin_overview('d3100000-0000-4000-8000-000000000014');
 assert o->'threshold'='null'::jsonb and o->'history'->0->'threshold'='null'::jsonb and o->'history'->0->>'previous'='0.00','0 and "not set" differ';
 -- Before approval the batches have no cost: a reason, not zero.
 assert (select bool_and(r->>'reason'='no_cost' and r->'margin_pct'='null'::jsonb) from jsonb_array_elements(o->'rows') r);
end $$;
reset role;
do $$begin assert pg_temp.alerts()=0,'no cost, no alert';end $$;
select pg_temp.fails($q$update public.customer_margin_thresholds set threshold_pct=1$q$,'неизменяема');

-- 2. Approval with a failing check: the approval stands, costs are the same as without the check.
savepoint failing_check;
create or replace function private.price_review_alerts(p_batch_ids uuid[]) returns integer language plpgsql as $$
begin raise exception 'SYNTHETIC_CHECK_FAILURE'; end $$;
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.approve_shipment_cost(public.calculate_shipment_cost(pg_temp.id('ship'),pg_temp.cur('EUR')));
reset role;
-- The savepoint below undoes everything, so the result is compared with the same expected figures as the real run.
do $$begin
 assert (pg_temp.batch('D3-LOT-A')).unit_landed_cost=10 and (pg_temp.batch('D3-LOT-B')).unit_landed_cost=12
   and (pg_temp.batch('D3-LOT-B')).cost_uom='piece' and (pg_temp.batch('D3-LOT-B')).cost_currency_id=pg_temp.cur('EUR'),
   'approval stands despite the failing check';
 assert pg_temp.alerts()=0;
end $$;
rollback to failing_check;
do $$begin assert (select unit_landed_cost is null from pg_temp.batch('D3-LOT-A')),'savepoint undone';end $$;

-- 3. The real approval: same costs; LOT-B is below the threshold of three customers -> one alert per recipient.
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.approve_shipment_cost(public.calculate_shipment_cost(pg_temp.id('ship'),pg_temp.cur('EUR')));
reset role;
do $$begin
 assert (pg_temp.batch('D3-LOT-A')).unit_landed_cost=10 and (pg_temp.batch('D3-LOT-B')).unit_landed_cost=12
   and (pg_temp.batch('D3-LOT-B')).cost_uom='piece' and (pg_temp.batch('D3-LOT-B')).cost_currency_id=pg_temp.cur('EUR'),
   'approval result identical with and without the check';
 assert (select price=8400 from public.price_list_entries where product_id='d3200000-0000-4000-8000-000000000001'),'the price is not changed';
 assert (select count(*) from public.price_list_entries where product_id='d3200000-0000-4000-8000-000000000001')=1;
end $$;
-- No VAT rate yet: price with VAT gives a reason, no alert.
do $$begin assert pg_temp.alerts()=0,'without a VAT rate no margin can be computed';end $$;
insert into public.vat_rates(country,rate,valid_from,reason,created_by) values ('KZ',0.12,'2020-01-01','Синтетическая ставка','d3000000-0000-4000-8000-000000000002');
-- A VAT rate does not trigger the check by itself; the next check (here: run as after an approval) sees it.
select private.price_review_alerts(null);
do $$
declare n record;
begin
 -- Recipients: can change the price list and see purchase prices (both administrators; not the director or the others).
 assert (select count(*) from public.notifications where type='price_review' and entity_id='d3200000-0000-4000-8000-000000000001'
   and recipient_user_id in ('d3000000-0000-4000-8000-000000000002','d3000000-0000-4000-8000-000000000003'))=2,'one alert per recipient';
 assert not exists(select 1 from public.notifications where type='price_review' and recipient_user_id in
   ('d3000000-0000-4000-8000-000000000001','d3000000-0000-4000-8000-000000000004','d3000000-0000-4000-8000-000000000005'));
 select * into n from public.notifications where type='price_review' and recipient_user_id='d3000000-0000-4000-8000-000000000002';
 assert n.title='Проверьте цену: D3-A' and n.body ~ 'D3-LOT-B' and n.body ~ 'клиентов: 3' and n.entity_type='price_review',
   'one alert for the batch, with the number of customers';
 assert n.body !~ '[0-9]{3,}','no amounts or costs in the text';
end $$;
-- Same state again: nothing new. A changed threshold: notified again.
select private.price_review_alerts(null);
select private.refresh_batch_cost((pg_temp.batch('D3-LOT-B')).id);
do $$begin assert pg_temp.alerts()=2,'repeat without changes creates nothing';end $$;
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select public.set_customer_margin_threshold('d3100000-0000-4000-8000-000000000011',16,'Пересмотр порога');
reset role;
do $$begin assert pg_temp.alerts()=4,'a changed threshold is notified again (both recipients)';end $$;

-- 4. Figures. Net price 8400 / 1.12 = 7500 KZT. Cost A 10 EUR * 500 = 5000, B 12 * 500 = 6000.
--    Price list: A (7500-5000)/7500 = 33.33 %, markup 50 %; B 20 %, markup 25 %.
--    C1 7560 -> 6750: A 25.93 %, B 11.11 % (< 16). C2 7500: A 33.33 %, B 20 % (< 25). C3 7000 -> 6250: A 20 %, B 4 % (< 10).
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$
declare p jsonb;o jsonb;
begin
 p:=public.price_list_batch_margins('d3200000-0000-4000-8000-000000000001');
 assert jsonb_array_length(p->'batches')=2 and p->'batches'->0->>'batch_number'='D3-LOT-A','nearest expiry first';
 assert (p->'batches'->0->'margins'->'kz_prepayment'->>'margin_pct')::numeric=33.33 and (p->'batches'->0->'margins'->'kz_prepayment'->>'markup_pct')::numeric=50;
 assert (p->'batches'->1->'margins'->'kz_prepayment'->>'margin_pct')::numeric=20 and (p->'batches'->1->'margins'->'kz_prepayment'->>'markup_pct')::numeric=25,
   'one price, two batches, two margins';
 assert (p->'batches'->0->'margins'->'kz_prepayment'->>'net_price')::numeric=7500 and (p->'batches'->1->'margins'->'kz_prepayment'->>'cost')::numeric=6000;
 assert p->'batches'->0->>'cost_basis'='receipts' and p->'batches'->0->'available'->0->>'quantity'='100.000';
 o:=public.customer_margin_overview('d3100000-0000-4000-8000-000000000011');
 assert (select (r->>'margin_pct')::numeric=25.93 and not (r->>'below')::boolean from jsonb_array_elements(o->'rows') r where r->>'batch_number'='D3-LOT-A');
 assert (select (r->>'margin_pct')::numeric=11.11 and (r->>'below')::boolean and r->>'price'='7560.00' from jsonb_array_elements(o->'rows') r where r->>'batch_number'='D3-LOT-B');
 o:=public.customer_margin_overview('d3100000-0000-4000-8000-000000000013');
 assert (select (r->>'margin_pct')::numeric=4 and (r->>'below')::boolean and r->>'price_source'='fixed' from jsonb_array_elements(o->'rows') r where r->>'batch_number'='D3-LOT-B');
 o:=public.customer_margin_overview('d3100000-0000-4000-8000-000000000014');
 assert (select bool_and(not (r->>'below')::boolean) from jsonb_array_elements(o->'rows') r),'no threshold: nothing below';
end $$;
reset role;
do $$begin
 -- The shared formula gives the same figure as the price list for the same batch and price (block 3 uses it).
 assert (private.batch_margin((pg_temp.batch('D3-LOT-B')).id,8400,pg_temp.cur('KZT'),'piece',true,'KZ',current_date)->>'margin_pct')::numeric=20;
 -- A box without packaging is not guessed.
 assert private.batch_margin((pg_temp.batch('D3-LOT-B')).id,8400,pg_temp.cur('KZT'),'box',true,'KZ',current_date)->>'reason'='no_packaging';
 -- No official rate for the currency: a reason.
 assert private.batch_margin((pg_temp.batch('D3-LOT-B')).id,100,pg_temp.cur('RUB'),'piece',false,'RU',current_date)->>'reason'='no_rate';
end $$;

-- 5. Without prices.purchase.view: no cost or margin by any call.
select set_config('request.jwt.claim.sub','d3000000-0000-4000-8000-000000000004',true);
set local role authenticated;
select pg_temp.fails($q$select public.price_list_batch_margins('d3200000-0000-4000-8000-000000000001')$q$,'Нет доступа к себестоимости');
select pg_temp.fails($q$select public.customer_margin_overview('d3100000-0000-4000-8000-000000000011')$q$,'Нет доступа');
select pg_temp.fails($q$select private.batch_margin(null,null,null,null,null,null,null)$q$,'permission denied');
select pg_temp.fails($q$select * from public.customer_margin_thresholds$q$,'permission denied');
reset role;
do $$begin
 assert not has_function_privilege('anon','public.price_list_batch_margins(uuid,date)','execute');
 assert not has_function_privilege('authenticated','private.price_review_alerts(uuid[])','execute');
 assert (select count(*) from public.role_permissions rp join public.permissions p on p.id=rp.permission_id
   where p.code='pricing.margin_threshold.manage' and rp.granted)=1,'only the administrator role';
end $$;
rollback;
\echo batch_price_margins: all checks passed
