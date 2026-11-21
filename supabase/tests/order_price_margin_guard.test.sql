-- 202611210500: a manual order price below the customer's margin threshold (or with a margin that cannot be checked)
-- needs the right sales.price_below_margin, when the price is set and when the order is confirmed. Worst batch:
-- reserved batches, otherwise those that would ship first. Synthetic data only; everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ad100000-0000-4000-8000-000000000001','margin-guard-director@example.invalid','{"full_name":"Margin guard director"}'),
 ('ad100000-0000-4000-8000-000000000002','margin-guard-manager@example.invalid','{"full_name":"Manager without the right"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ad100000-0000-4000-8000-000000000001'::uuid,'director'),('ad100000-0000-4000-8000-000000000002'::uuid,'director')) u(id,code)
 join public.app_roles r on r.code=u.code;
-- The manager may change orders but not price below the threshold.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ad100000-0000-4000-8000-000000000002',id,'deny','Manager without the right','ad100000-0000-4000-8000-000000000001'
 from public.permissions where code='sales.price_below_margin';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ad110000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Margin guard supplier','FI','AD1-SUP'),
 ('ad110000-0000-4000-8000-000000000002',array['customer'],'Клиент с порогом','KZ','AD1-C1'),
 ('ad110000-0000-4000-8000-000000000003',array['customer'],'Клиент без порога','KZ','AD1-C2');
insert into public.warehouses(id,code,name,city,country) values
 ('ad130000-0000-4000-8000-000000000001','AD1-WH','{"ru":"Склад проверки маржи"}','Almaty','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ad120000-0000-4000-8000-000000000001','AD1-A','{"ru":"Товар двух партий"}','ad110000-0000-4000-8000-000000000001','active'),
 ('ad120000-0000-4000-8000-000000000002','AD1-B','{"ru":"Товар без себестоимости"}','ad110000-0000-4000-8000-000000000001','active');
insert into public.customer_price_terms(customer_id,price_type_id,contract_currency_id,valid_from,reason,created_by)
 select c.id,(select id from public.price_types where code='kz_prepayment'),(select id from public.currencies where code='KZT'),'2020-01-01','Договор','ad100000-0000-4000-8000-000000000001'
 from public.counterparties c where c.tax_id in ('AD1-C1','AD1-C2');
insert into public.vat_rates(country,rate,valid_from,reason,created_by) values ('KZ',0.12,'2020-01-01','Синтетическая ставка','ad100000-0000-4000-8000-000000000001');
insert into public.customer_margin_thresholds(customer_id,threshold_pct,reason,created_by) values
 ('ad110000-0000-4000-8000-000000000002',20,'Порог клиента','ad100000-0000-4000-8000-000000000001');
-- LOT-1: 100 KZT per piece, 5 free, ships first; LOT-2: 150 KZT, 100 free; product B: a batch without cost.
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,status,unit_landed_cost,cost_currency_id,cost_uom,created_by)
 select b.id,b.product_id,b.number,b.expiry,'available',b.cost,(select id from public.currencies where code='KZT'),'piece','ad100000-0000-4000-8000-000000000001'
 from (values ('ad140000-0000-4000-8000-000000000001'::uuid,'ad120000-0000-4000-8000-000000000001'::uuid,'AD1-LOT-1',current_date+100,100::numeric),
              ('ad140000-0000-4000-8000-000000000002'::uuid,'ad120000-0000-4000-8000-000000000001'::uuid,'AD1-LOT-2',current_date+300,150::numeric),
              ('ad140000-0000-4000-8000-000000000003'::uuid,'ad120000-0000-4000-8000-000000000002'::uuid,'AD1-LOT-3',current_date+300,null::numeric)) b(id,product_id,number,expiry,cost);
insert into public.inventory_balances(batch_id,warehouse_id,uom,quantity_on_hand) values
 ('ad140000-0000-4000-8000-000000000001','ad130000-0000-4000-8000-000000000001','piece',5),
 ('ad140000-0000-4000-8000-000000000002','ad130000-0000-4000-8000-000000000001','piece',100),
 ('ad140000-0000-4000-8000-000000000003','ad130000-0000-4000-8000-000000000001','piece',100);

create temporary table ad(k text primary key,id uuid);
grant all on ad to authenticated;
create function pg_temp.kzt() returns uuid language sql stable security definer as $$ select id from public.currencies where code='KZT' $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.line(p_k text) returns public.sale_items language sql stable security definer as $$
 select * from public.sale_items where id=(select id from ad where k=p_k) $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 0. The right went to every role that may change orders.
do $$begin
 assert not exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id and p.code='sales.manage' and rp.granted
   where not exists(select 1 from public.role_permissions x join public.permissions q on q.id=x.permission_id and q.code='sales.price_below_margin'
                     where x.role_id=rp.role_id and x.granted)),'every role with sales.manage keeps manual prices below the threshold';
end $$;

-- With VAT 12 %: a price of 168 is 150 without VAT. Margin at LOT-1 (cost 100): 33.33 %; at LOT-2 (cost 150): 0 %.
select set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-000000000002',true);
set local role authenticated;
insert into ad values
 ('sale',public.create_customer_order('ad110000-0000-4000-8000-000000000002',null,'ad130000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null)),
 ('sale2',public.create_customer_order('ad110000-0000-4000-8000-000000000003',null,'ad130000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null));
-- 1. Three pieces ship from LOT-1 only: 33.33 % is above 20 %, the manager may set it.
insert into ad values ('a',public.add_customer_order_item((select id from ad where k='sale'),'ad120000-0000-4000-8000-000000000001',3,'piece',168,null,'Согласовано с клиентом'));
-- 2. A margin that cannot be computed (product B has no cost) counts as below: refused, no line is added.
select pg_temp.fails($q$select public.add_customer_order_item((select id from ad where k='sale'),'ad120000-0000-4000-8000-000000000002',1,'piece',500,null,'Без себестоимости')$q$,
 'Маржу ручной цены не проверить: у партии нет себестоимости');
-- 3. Changing the price of line A below the threshold is refused too; the line keeps its price.
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ad where k='a'),120,'Скидка')$q$,
 'Ручная цена ниже порога маржи клиента');
-- 4. A customer without a threshold is not checked.
insert into ad values ('free',public.add_customer_order_item((select id from ad where k='sale2'),'ad120000-0000-4000-8000-000000000001',10,'piece',1,null,'Без порога'));
reset role;
do $$begin
 assert (pg_temp.line('a')).unit_price=168 and (pg_temp.line('a')).price_source='manual','line A keeps 168';
 assert not exists(select 1 from public.sale_items where sale_id=(select id from ad where k='sale') and product_id='ad120000-0000-4000-8000-000000000002'),
   'no line without a checkable margin was added';
 assert (pg_temp.line('free')).unit_price=1,'no threshold, no check';
end $$;
-- The ten-piece case, checked directly: LOT-1 then LOT-2, the worst is 0 %.
do $$declare r jsonb;begin
 r:=private.sale_line_margin_check((select id from ad where k='sale'),null,'ad120000-0000-4000-8000-000000000001',10,'piece',168);
 assert (r->>'below')::boolean and (r->>'worst_margin_pct')::numeric=0 and (r->>'batches')::int=2 and r->>'reason' is null,r::text;
 r:=private.sale_line_margin_check((select id from ad where k='sale'),null,'ad120000-0000-4000-8000-000000000001',5,'piece',168);
 assert not (r->>'below')::boolean and (r->>'worst_margin_pct')::numeric=33.33 and (r->>'batches')::int=1,r::text;
end $$;
set local role authenticated;
select pg_temp.fails($q$select public.add_customer_order_item((select id from ad where k='sale'),'ad120000-0000-4000-8000-000000000001',10,'piece',168,null,'Много штук')$q$,
 'Ручная цена ниже порога маржи клиента');
reset role;

-- 5. The director has the right: line A gets 120 (107.14 without VAT, 6.67 % at LOT-1), below the threshold.
select set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.set_customer_order_item_price((select id from ad where k='a'),120,'Решение директора');
reset role;
do $$begin
 assert (pg_temp.line('a')).unit_price=120,'the director set 120';
end $$;

-- 6. A reservation decides the batches. Ten pieces of line A at 120: without a reservation LOT-1 and LOT-2 ship
--    (worst -40 %: (107.14 - 150) / 107.14); reserved on LOT-1 only, the worst is 6.67 %.
update public.sale_items set quantity=10 where id=(select id from ad where k='a');
do $$declare r jsonb;begin
 r:=private.sale_line_margin_check((select id from ad where k='sale'),(select id from ad where k='a'),'ad120000-0000-4000-8000-000000000001',10,'piece',120);
 assert (r->>'below')::boolean and (r->>'worst_margin_pct')::numeric=-40 and (r->>'batches')::int=2,'no reservation: '||r::text;
end $$;
insert into public.inventory_reservations(sale_item_id,inventory_balance_id,batch_id,quantity,remaining_shelf_life_pct,created_by)
 select (select id from ad where k='a'),bal.id,bal.batch_id,5,90,'ad100000-0000-4000-8000-000000000001'
 from public.inventory_balances bal where bal.batch_id='ad140000-0000-4000-8000-000000000001';
do $$declare r jsonb;begin
 r:=private.sale_line_margin_check((select id from ad where k='sale'),(select id from ad where k='a'),'ad120000-0000-4000-8000-000000000001',10,'piece',120);
 assert (r->>'below')::boolean and (r->>'worst_margin_pct')::numeric=6.67 and (r->>'batches')::int=1,'reserved on LOT-1: '||r::text;
end $$;
delete from public.inventory_reservations where sale_item_id=(select id from ad where k='a');

-- 7. Confirmation checks again: line A at 120 is below the threshold. The manager cannot confirm, the director can.
update public.sales set status='reserved' where id=(select id from ad where k='sale');
select set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select public.confirm_customer_order((select id from ad where k='sale'))$q$,
 'ниже порога маржи клиента или без проверки маржи — 1');
reset role;
do $$begin
 assert (select status from public.sales where id=(select id from ad where k='sale'))='reserved','the order stays reserved';
end $$;
select set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-000000000001',true);
set local role authenticated;
select public.confirm_customer_order((select id from ad where k='sale'));
reset role;
do $$begin
 assert (select status from public.sales where id=(select id from ad where k='sale'))='confirmed','the director confirms';
 assert not has_function_privilege('authenticated','private.sale_line_margin_check(uuid,uuid,uuid,numeric,text,numeric)','execute');
 assert not has_function_privilege('anon','private.sale_line_margin_check(uuid,uuid,uuid,numeric,text,numeric)','execute');
end $$;
\echo order_price_margin_guard: all checks passed
rollback;
