-- 202611170500: profitability by shipment, product and customer. Synthetic scenario: two shipments, three batches,
-- sales to two customers, one return. Real path: receiving, cost approval, order, FEFO reservation, confirmation,
-- fulfillment, return. Hand calculations next to every check. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('d5000000-0000-4000-8000-000000000001','profit-director@example.invalid','{"full_name":"Profit director"}'),
 ('d5000000-0000-4000-8000-000000000002','profit-denied@example.invalid','{"full_name":"Director without purchase prices"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('d5000000-0000-4000-8000-000000000001'::uuid,'director'),('d5000000-0000-4000-8000-000000000002'::uuid,'director')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'd5000000-0000-4000-8000-000000000002',id,'deny','No purchase prices','d5000000-0000-4000-8000-000000000001'
 from public.permissions where code='prices.purchase.view';
-- The test user also needs the rights of the whole path (reports, returns, stock moves) whatever the role gives.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'd5000000-0000-4000-8000-000000000001',id,'allow','Synthetic full path','d5000000-0000-4000-8000-000000000001'
 from public.permissions where code in ('reports.view','sales.returns','inventory.move','sales.reserve','sales.manage','sales.view','sales.override_fefo');
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'd5000000-0000-4000-8000-000000000002',id,'allow','Synthetic reports','d5000000-0000-4000-8000-000000000001'
 from public.permissions where code='reports.view';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('d5100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Profit supplier','FI','D5-SUP'),
 ('d5100000-0000-4000-8000-000000000011',array['customer'],'Казахстанский клиент','KZ','D5-C1'),
 ('d5100000-0000-4000-8000-000000000012',array['customer'],'Экспортный клиент','RU','D5-C2');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('d5200000-0000-4000-8000-000000000001','D5-A','{"ru":"Товар A"}','d5100000-0000-4000-8000-000000000001','active'),
 ('d5200000-0000-4000-8000-000000000002','D5-B','{"ru":"Товар B"}','d5100000-0000-4000-8000-000000000001','active');
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 select (select id from public.currencies where code='EUR'),(select id from public.currencies where code='KZT'),500,'official',current_date-1,
 'd5000000-0000-4000-8000-000000000001';
insert into public.vat_rates(country,rate,valid_from,reason,created_by) values ('KZ',0.12,'2020-01-01','Синтетическая ставка','d5000000-0000-4000-8000-000000000001');

create temporary table d5(k text primary key,id uuid);
grant all on d5 to authenticated;
create function pg_temp.id(p_key text) returns uuid language sql stable as $$ select id from d5 where k=p_key $$;
create function pg_temp.cur(p_code text) returns uuid language sql stable as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.wh() returns uuid language sql stable security definer as $$
 select id from public.warehouses where status='active' and not is_virtual order by code limit 1 $$;
create function pg_temp.batch(p_number text) returns uuid language sql stable security definer as $$
 select id from public.inventory_batches where batch_number=p_number $$;
-- A shipment of one vehicle: lines [{"product":..,"qty":..,"price":..,"batch":..,"expiry_days":..}], received and approved in EUR.
create function pg_temp.ship(p_code text,p_lines jsonb) returns void language plpgsql as $$
declare v_ship uuid;v_t uuid;v_line jsonb;v_receipt jsonb:='[]';v_item uuid;
begin
 v_ship:=public.create_shipment_with_stages(p_code,'import','d5100000-0000-4000-8000-000000000001',null,
  (select id from public.routes where status='active' order by created_at limit 1),pg_temp.cur('EUR'),pg_temp.wh(),auth.uid(),current_date,current_date+14);
 insert into d5 values(p_code,v_ship);
 perform public.add_shipment_transport(v_ship,null,null,null,null);
 select id into v_t from public.shipment_transports where shipment_id=v_ship;
 for v_line in select * from jsonb_array_elements(p_lines) loop
  v_item:=public.allocate_shipment_item(public.create_shipment_item(v_ship,(v_line->>'product')::uuid,'piece',(v_line->>'qty')::numeric,
   (v_line->>'price')::numeric,pg_temp.cur('EUR')),v_t,(v_line->>'qty')::numeric);
  v_receipt:=v_receipt||jsonb_build_object('item_id',v_item,'accepted_quantity',(v_line->>'qty')::numeric,'batch_number',v_line->>'batch',
   'expiry_date',(current_date+(v_line->>'expiry_days')::int)::text);
 end loop;
 perform public.change_shipment_transport_status(v_t,'arrived');
 perform public.receive_shipment_transport(v_t,null,v_receipt,'Кладовщик',null);
 perform public.approve_shipment_cost(public.calculate_shipment_cost(v_ship,pg_temp.cur('EUR')));
end $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.row(p_report jsonb,p_name text) returns jsonb language sql immutable as $$
 select r from jsonb_array_elements(p_report->'rows') r where r->>'name' like p_name||'%' $$;
create function pg_temp.keyed(p_report jsonb,p_key uuid) returns jsonb language sql immutable as $$
 select r from jsonb_array_elements(p_report->'rows') r where r->>'key'=p_key::text $$;
grant execute on all functions in schema pg_temp to authenticated;

select set_config('request.jwt.claim.sub','d5000000-0000-4000-8000-000000000001',true);
set local role authenticated;
-- S1: A1 100 pcs at 10 EUR (expires first), B1 100 pcs at 20 EUR. S2: A2 100 pcs at 12 EUR.
select pg_temp.ship('D5-S1','[{"product":"d5200000-0000-4000-8000-000000000001","qty":100,"price":10,"batch":"D5-A1","expiry_days":200},
 {"product":"d5200000-0000-4000-8000-000000000002","qty":100,"price":20,"batch":"D5-B1","expiry_days":200}]');
select pg_temp.ship('D5-S2','[{"product":"d5200000-0000-4000-8000-000000000001","qty":100,"price":12,"batch":"D5-A2","expiry_days":300}]');
-- C1 (Kazakhstan, KZT, price with VAT): A 150 pcs at 8400 KZT -> FEFO 100 from A1, 50 from A2.
-- C2 (export, EUR, no VAT): B 50 pcs at 30 EUR, and A 10 pcs without a price (no price list for C2).
do $$
declare v_item uuid;
begin
 insert into d5 values('sale1',public.create_customer_order('d5100000-0000-4000-8000-000000000011',null,pg_temp.wh(),current_date+1,pg_temp.cur('KZT'),null));
 v_item:=public.add_customer_order_item(pg_temp.id('sale1'),'d5200000-0000-4000-8000-000000000001',150,'piece',8400,0,'Цена по письму клиента');
 insert into d5 values('item1',v_item);
 perform public.reserve_customer_order_item_fefo(v_item);
 perform public.confirm_customer_order(pg_temp.id('sale1'));
 perform public.fulfill_customer_order(pg_temp.id('sale1'));
 insert into d5 values('sale2',public.create_customer_order('d5100000-0000-4000-8000-000000000012',null,pg_temp.wh(),current_date+1,pg_temp.cur('EUR'),null));
 insert into d5 values('item2b',public.add_customer_order_item(pg_temp.id('sale2'),'d5200000-0000-4000-8000-000000000002',50,'piece',30,0,'Экспортная цена'));
 insert into d5 values('item2a',public.add_customer_order_item(pg_temp.id('sale2'),'d5200000-0000-4000-8000-000000000001',10,'piece',null,0));
 perform public.reserve_customer_order_item_fefo(pg_temp.id('item2b'));
 perform public.reserve_customer_order_item_fefo(pg_temp.id('item2a'));
 perform public.confirm_customer_order(pg_temp.id('sale2'));
 perform public.fulfill_customer_order(pg_temp.id('sale2'));
 -- C1 returns 20 pcs of A from A1.
 perform public.create_customer_return(pg_temp.id('sale1'),jsonb_build_array(jsonb_build_object('sale_item_id',pg_temp.id('item1'),
   'batch_id',pg_temp.batch('D5-A1'),'quantity',20,'reason_code','damaged')));
end $$;

-- Hand calculation (KZT, official rate 500, VAT 12 %):
--   C1 A1: 100 x 8400/1.12 = 750 000; cost 100 x 10 x 500 = 500 000.   C1 A2: 50 x 7500 = 375 000; cost 50 x 6000 = 300 000.
--   C2 B1: 50 x 30 x 500 = 750 000 (no VAT); cost 50 x 20 x 500 = 500 000.   C2 A2 10 pcs: no price.
--   Return A1: -20 x 7500 = -150 000; cost -20 x 5000 = -100 000.
--   Complete revenue 1 725 000, cost 1 200 000, profit 525 000, margin 30.43 %.
do $$
declare r jsonb;s jsonb;p jsonb;c jsonb;l jsonb;
begin
 s:=public.profitability_report('shipment',current_date-1,current_date+1);
 p:=public.profitability_report('product',current_date-1,current_date+1);
 c:=public.profitability_report('customer',current_date-1,current_date+1);
 assert s->'totals'->>'profit'='525000.00' and p->'totals'->>'profit'='525000.00' and c->'totals'->>'profit'='525000.00',
   'one gross profit by shipment, product and customer: '||(s->'totals')::text;
 assert (select sum((x->>'profit')::numeric) from jsonb_array_elements(s->'rows') x)=525000
   and (select sum((x->>'profit')::numeric) from jsonb_array_elements(p->'rows') x)=525000
   and (select sum((x->>'profit')::numeric) from jsonb_array_elements(c->'rows') x)=525000,'rows add up to the total';
 assert s->'totals'->>'cost'='1200000.00' and s->'totals'->>'complete_revenue'='1725000.00' and s->'totals'->>'returns_net'='-150000.00';
 assert (s->'totals'->>'incomplete_lines')::int=1,'the unpriced line is counted, not hidden';
 -- By shipment: S1 = A1 750 000 + B1 750 000 - return 150 000 = 1 350 000, cost 900 000, profit 450 000; S2 = 75 000.
 r:=pg_temp.keyed(s,pg_temp.id('D5-S1'));
 assert r->>'complete_revenue'='1350000.00' and r->>'cost'='900000.00' and r->>'profit'='450000.00' and r->>'returns_net'='-150000.00';
 r:=pg_temp.keyed(s,pg_temp.id('D5-S2'));
 assert r->>'profit'='75000.00' and (r->>'margin_pct')::numeric=20 and r->'statuses'->>'no_price'='1' and r->>'unsold_pieces'='40.000',
   'S2: 40 of 100 pieces unsold; the unpriced line is marked';
 -- By product: A 975 000 - 700 000 = 275 000 (28.21 %); B 250 000 (33.33 %).
 r:=pg_temp.row(p,'D5-A');
 assert r->>'profit'='275000.00' and (r->>'margin_pct')::numeric=28.21;
 r:=pg_temp.row(p,'D5-B');
 assert r->>'profit'='250000.00' and (r->>'margin_pct')::numeric=33.33 and r->>'sales_gross'='750000.00';
 -- By customer: C1 275 000 with the return; C2 250 000.
 assert pg_temp.row(c,'Казахстанский')->>'profit'='275000.00' and pg_temp.row(c,'Казахстанский')->>'revenue_gross'='1092000.00',
   'with VAT: (150 - 20) x 8400 = 1 092 000';
 assert pg_temp.row(c,'Экспортный')->>'profit'='250000.00';
 -- Lines: the same margin per piece as the price list formula of block 1Б for the same batch and price.
 l:=public.profitability_lines(current_date-1,current_date+1);
 assert (select x->>'status'='no_price' and x->'revenue_net_kzt'='null'::jsonb from jsonb_array_elements(l) x where x->>'customer'='Экспортный клиент' and x->>'product'='D5-A');
 assert (select x->>'revenue_rate_date'=(current_date-1)::text from jsonb_array_elements(l) x where x->>'customer'='Экспортный клиент' and x->>'product'='D5-B'),
   'no rate on the day: the official rate of the day before, with its date';
end $$;
reset role;
do $$begin
 assert (private.batch_margin(pg_temp.batch('D5-A1'),8400,pg_temp.cur('KZT'),'piece',true,'KZ',current_date)->>'margin_pct')::numeric
   = (select round(((x->>'revenue_net_kzt')::numeric-(x->>'cost_kzt')::numeric)/(x->>'revenue_net_kzt')::numeric*100,2)
        from private.profit_lines(current_date-1,current_date+1) y,
             lateral (select jsonb_build_object('revenue_net_kzt',y.revenue_net_kzt,'cost_kzt',y.cost_kzt) x) z
       where y.kind='sale' and y.batch_number='D5-A1'),
   'report and price list give the same margin for the same batch and price';
end $$;

-- No official rate: the line is "нет курса", never converted at 1.
savepoint no_rate;
delete from public.exchange_rates where rate_date=current_date-1 and rate=500;
set local role authenticated;
do $$begin
 assert (select bool_and(x->>'status' in ('no_rate','no_price')) from jsonb_array_elements(public.profitability_lines(current_date-1,current_date+1)) x),
   'every converted line is "no rate"';
 assert public.profitability_report('customer',current_date-1,current_date+1)->'totals'->>'profit'='0';
end $$;
reset role;
rollback to no_rate;

-- Without purchase prices: a refusal, not empty figures.
select set_config('request.jwt.claim.sub','d5000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.profitability_report('product',current_date-1,current_date+1)$q$,'Нет доступа к отчёту о прибыльности');
select pg_temp.fails($q$select public.profitability_lines(current_date-1,current_date+1)$q$,'Нет доступа к отчёту о прибыльности');
reset role;
do $$begin
 assert not has_function_privilege('anon','public.profitability_report(text,date,date)','execute');
 assert not has_function_privilege('authenticated','private.profit_lines(date,date)','execute');
end $$;
rollback;
\echo profitability: all checks passed
