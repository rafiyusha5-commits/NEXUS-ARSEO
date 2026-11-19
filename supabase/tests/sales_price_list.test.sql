-- 202611170100: price list, import with conflicts, customer conditions and the price a customer gets.
-- Synthetic data only. Hand calculations are next to every check. Everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('d1000000-0000-4000-8000-000000000001','price-admin@example.invalid','{"full_name":"Price administrator"}'),
 ('d1000000-0000-4000-8000-000000000002','price-commercial@example.invalid','{"full_name":"Commercial director"}'),
 ('d1000000-0000-4000-8000-000000000003','price-logistics@example.invalid','{"full_name":"Logistics specialist"}'),
 ('d1000000-0000-4000-8000-000000000004','price-denied@example.invalid','{"full_name":"Administrator with personal deny"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('d1000000-0000-4000-8000-000000000001'::uuid,'administrator'),
 ('d1000000-0000-4000-8000-000000000002'::uuid,'commercial_director'),
 ('d1000000-0000-4000-8000-000000000003'::uuid,'logistics_specialist'),
 ('d1000000-0000-4000-8000-000000000004'::uuid,'administrator')) u(id,code) join public.app_roles r on r.code=u.code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'd1000000-0000-4000-8000-000000000004',id,'deny','Personal deny of price changes','d1000000-0000-4000-8000-000000000001'
 from public.permissions where code in ('pricing.list.manage','pricing.customer_terms.manage');

insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('d1100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Price supplier','FI','D1-SUP'),
 ('d1100000-0000-4000-8000-000000000002',array['customer'],'Казахстанская сеть','KZ','D1-KZ'),
 ('d1100000-0000-4000-8000-000000000003',array['customer'],'Российский клиент RUB','RU','D1-RUB'),
 ('d1100000-0000-4000-8000-000000000004',array['customer'],'Российский клиент EUR','RU','D1-EUR'),
 ('d1100000-0000-4000-8000-000000000005',array['customer'],'Российский клиент KZT','RU','D1-KZT'),
 ('d1100000-0000-4000-8000-000000000006',array['customer'],'Кыргызский клиент RUB','KG','D1-KG');
insert into public.products(id,internal_sku,name,manufacturer_id,brand,status) values
 ('d1200000-0000-4000-8000-000000000001','D1-A','{"ru":"Товар бренда A"}','d1100000-0000-4000-8000-000000000001','Fazer','active'),
 ('d1200000-0000-4000-8000-000000000002','D1-B','{"ru":"Товар бренда B"}','d1100000-0000-4000-8000-000000000001','Trolli','active'),
 ('d1200000-0000-4000-8000-000000000003','D1-NOBRAND','{"ru":"Без бренда"}','d1100000-0000-4000-8000-000000000001',null,'active'),
 ('d1200000-0000-4000-8000-000000000004','D1-C','{"ru":"Бренд без условия"}','d1100000-0000-4000-8000-000000000001','Yilmaz','active'),
 ('d1200000-0000-4000-8000-000000000005','D1-NOPRICE','{"ru":"Без цены"}','d1100000-0000-4000-8000-000000000001','FAZER ','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values ('d1200000-0000-4000-8000-000000000001','box',12);
insert into public.exchange_rates(base_currency_id,quote_currency_id,rate,source,rate_date,created_by)
 select (select id from public.currencies where code=b),(select id from public.currencies where code='KZT'),r,s,d::date,'d1000000-0000-4000-8000-000000000001'
 from (values('EUR',500::numeric,'official','2026-06-10'),('RUB',6::numeric,'official','2026-06-10'),
             ('EUR',520::numeric,'official','2026-06-20'),('RUB',6.5::numeric,'bank','2026-06-20')) v(b,r,s,d);

-- Calculator snapshot as the read-only import leaves it: sales columns by key with position and label.
insert into public.product_master_sources(source_key,title,sheet_name,header_fingerprint,columns)
select 'arseo-master-calculator','Synthetic calculator','расчеты',repeat('a',64),jsonb_agg(jsonb_build_object(
  'key',t.source_column_key,'position',t.source_position,'block','УСТАНОВЛЕННЫЕ ЦЕНЫ','field_ru',t.source_field_ru,'visibility','sales'))
 from public.price_types t where t.source_column_key is not null
on conflict (source_key) do update set columns=excluded.columns,header_fingerprint=excluded.header_fingerprint;
delete from public.product_master_data where source_key='arseo-master-calculator';
insert into public.product_master_data(product_id,source_key,source_row,sales_data) values
 ('d1200000-0000-4000-8000-000000000001','arseo-master-calculator',6,jsonb_build_object(
   'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2',1000,
   'source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt.2','1 200,00',
   'source.установленные_цены.кыргызстан_exw_ala_без_ндс_eur',2)),
 ('d1200000-0000-4000-8000-000000000002','arseo-master-calculator',7,jsonb_build_object(
   'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2',2000)),
 ('d1200000-0000-4000-8000-000000000003','arseo-master-calculator',8,jsonb_build_object(
   'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2',300)),
 ('d1200000-0000-4000-8000-000000000004','arseo-master-calculator',9,jsonb_build_object(
   'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2',400,'source.установленные_цены.цп_лента','не число'));

create temporary table d1(k text primary key,v jsonb);
grant all on d1 to authenticated;
create function pg_temp.t(p_code text) returns uuid language sql stable security definer as $$ select id from public.price_types where code=p_code $$;
create function pg_temp.c(p_code text) returns uuid language sql stable security definer as $$ select id from public.currencies where code=p_code $$;
create function pg_temp.q(p_customer text,p_product text,p_date date,p_uom text default 'piece') returns jsonb language sql stable as $$
 select public.customer_price_quote(('d1100000-0000-4000-8000-00000000000'||p_customer)::uuid,('d1200000-0000-4000-8000-00000000000'||p_product)::uuid,p_uom,p_date) $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;

-- 1. Import from the calculator: preview, then confirm. Lenta "не число" is invalid, not zero.
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into d1 select 'p1',public.price_list_import_preview('2026-06-01');
do $$
declare p jsonb:=(select v from d1 where k='p1');
begin
 assert (p->>'ok')::boolean;
 assert (p->'counts'->>'new')::int=6,'4 KZ prepayment (A, B, no brand, C) + export RU (A) + export KG (A) = 6';
 assert (select count(*) from jsonb_array_elements(p->'rows') r where r->>'status'='invalid' and r->>'price_type'='lenta')=1,'text instead of a number is invalid';
 assert (select r->>'sheet_value' from jsonb_array_elements(p->'rows') r where r->>'price_type'='export_ru' and r->>'sku'='D1-A')='1200.00',
  'the sheet text "1 200,00" is read as 1200.00';
 end $$;
reset role;
do $$begin assert not exists(select 1 from public.price_list_entries),'the preview writes nothing';end $$;
set local role authenticated;
select public.confirm_price_list_import('d1300000-0000-4000-8000-000000000001',(select v->>'stamp' from d1 where k='p1'),'2026-06-01','{}');
-- Repeating the same request returns the same result and writes nothing more.
select public.confirm_price_list_import('d1300000-0000-4000-8000-000000000001',(select v->>'stamp' from d1 where k='p1'),'2026-06-01','{}');
reset role;
do $$begin
 assert (select count(*) from public.price_list_entries)=(select ((v->'counts'->>'new')::int) from d1 where k='p1'),'one entry per new price, repeat is a no-op';
 assert (select bool_and(origin='calculator' and source ? 'source_row' and source ? 'column_key') from public.price_list_entries),'each price keeps its source';
end $$;

-- 2. Brands directory: "Fazer" and "FAZER " are one brand; "Trolli" and "Yilmaz" are added; no product is rewritten.
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into d1 select 'brand_a',to_jsonb(public.save_brand('Fazer'));
insert into d1 select 'brand_b',to_jsonb(public.save_brand('Trolli'));
insert into d1 select 'brand_c',to_jsonb(public.save_brand('Yilmaz'));
do $$begin
 assert public.save_brand('  fazer ')=(select (v#>>'{}')::uuid from d1 where k='brand_a'),'the same brand is not duplicated';
 assert (select (public.brand_overview()->'unmatched'->0->>'text'))='','only the product without a brand stays unmatched';
end $$;
reset role;
do $$begin
 assert (select brand from public.products where id='d1200000-0000-4000-8000-000000000005')='FAZER ','product cards are not rewritten';
end $$;

-- 3. Customer conditions, set by the commercial director (pricing.customer_terms.manage).
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$declare n text;begin
 -- KZ chain: prepayment price list in KZT; Fazer +10 %, Trolli -5 %; no condition for Yilmaz.
 perform public.set_customer_price_terms('d1100000-0000-4000-8000-000000000002',pg_temp.t('kz_prepayment'),pg_temp.c('KZT'),'2026-06-01','Договор поставки');
 perform public.set_customer_brand_markup('d1100000-0000-4000-8000-000000000002',(select (v#>>'{}')::uuid from d1 where k='brand_a'),10,'2026-06-01','Наценка на Fazer');
 perform public.set_customer_brand_markup('d1100000-0000-4000-8000-000000000002',(select (v#>>'{}')::uuid from d1 where k='brand_b'),-5,'2026-06-01','Скидка на Trolli');
 -- From 2026-06-15 Fazer is +20 %.
 perform public.set_customer_brand_markup('d1100000-0000-4000-8000-000000000002',(select (v#>>'{}')::uuid from d1 where k='brand_a'),20,'2026-06-15','Новые условия');
 -- Export clients of the export_ru price list (KZT) with contracts in RUB, EUR and KZT; a KG client in RUB.
 perform public.set_customer_price_terms('d1100000-0000-4000-8000-000000000003',pg_temp.t('export_ru'),pg_temp.c('RUB'),'2026-06-01','Контракт в рублях');
 perform public.set_customer_price_terms('d1100000-0000-4000-8000-000000000004',pg_temp.t('export_ru'),pg_temp.c('EUR'),'2026-06-01','Контракт в евро');
 perform public.set_customer_price_terms('d1100000-0000-4000-8000-000000000005',pg_temp.t('export_ru'),pg_temp.c('KZT'),'2026-06-01','Контракт в тенге');
 perform public.set_customer_price_terms('d1100000-0000-4000-8000-000000000006',pg_temp.t('export_kg'),pg_temp.c('RUB'),'2026-06-01','Контракт в рублях');
 foreach n in array array['3','4','5','6'] loop
  perform public.set_customer_brand_markup(('d1100000-0000-4000-8000-00000000000'||n)::uuid,(select (x.v#>>'{}')::uuid from d1 x where x.k='brand_a'),0,'2026-06-01','Без наценки');
 end loop;
end $$;
-- The commercial director cannot change the price list itself.
select pg_temp.fails($q$select public.set_price_list_price(gen_random_uuid(),pg_temp.t('kz_prepayment'),'d1200000-0000-4000-8000-000000000001',1,'2026-06-01','Попытка')$q$,'Нет права изменять прайс');
reset role;

-- 4. Prices for the KZ chain on 2026-06-10.
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$
declare q jsonb;
begin
 q:=pg_temp.q('2','1','2026-06-10');
 assert (q->>'price')::numeric=1100 and q->>'source'='price_list' and (q->>'vat_included')::boolean,'Fazer: 1000 * 1.10 = 1100.00 KZT with VAT';
 q:=pg_temp.q('2','2','2026-06-10');
 assert (q->>'price')::numeric=1900,'Trolli: 2000 * 0.95 = 1900.00';
 q:=pg_temp.q('2','1','2026-06-20');
 assert (q->>'price')::numeric=1200,'from 2026-06-15 Fazer is +20 %: 1000 * 1.20 = 1200.00';
 q:=pg_temp.q('2','4','2026-06-10');
 assert (q->>'price')::numeric=400 and q->>'note'='brand_condition_missing' and q->'percent'='null'::jsonb,
  'brand without a condition: price list price without percent, noted';
 q:=pg_temp.q('2','3','2026-06-10');
 -- 202611180100: no brand in the directory = no condition for the brand (owner decision of 2026-11-18).
 assert q->'price'<>'null'::jsonb and q->>'source'='price_list' and q->>'note'='brand_missing' and q->'percent'='null'::jsonb
   and q->'brand'='null'::jsonb,'product without a brand: price list price without percent, noted brand_missing';
 q:=pg_temp.q('2','5','2026-06-10');
 assert q->'price'='null'::jsonb and q->>'reason'='no_price','no price in the price list: no price';
 q:=pg_temp.q('2','1','2026-06-10','box');
 assert (q->>'price')::numeric=13200,'a box of 12 through packaging: 1100 * 12 = 13200.00';
 q:=pg_temp.q('2','2','2026-06-10','box');
 assert q->'price'='null'::jsonb and q->>'reason'='no_packaging','no packaging: no price, no guess';
 q:=public.customer_price_quote('d1100000-0000-4000-8000-000000000002','d1200000-0000-4000-8000-000000000001','piece','2026-06-10',pg_temp.c('EUR'));
 assert q->>'reason'='currency_mismatch','an order in another currency than the contract gets no price';
 q:=pg_temp.q('2','1','2026-05-20');
 assert q->>'reason'='no_price_type','before the conditions start there is no price type';
end $$;

-- 5. Export price (1200 KZT) in three contract currencies, by official rates; through tenge; without a rate.
do $$
declare q jsonb;
begin
 q:=pg_temp.q('3','1','2026-06-10');
 assert (q->>'price')::numeric=200 and q->>'rate_path'='inverse' and (q->>'vat_included')::boolean=false,
  'RUB contract: 1200 KZT / 6 = 200.00 RUB, inverse of the official RUB/KZT rate';
 q:=pg_temp.q('4','1','2026-06-10');
 assert (q->>'price')::numeric=2.4 and (q->>'rate_date')::date='2026-06-10','EUR contract: 1200 / 500 = 2.40 EUR';
 q:=pg_temp.q('5','1','2026-06-10');
 assert (q->>'price')::numeric=1200 and q->>'rate_path'='same','KZT contract: no conversion';
 q:=pg_temp.q('6','1','2026-06-10');
 assert (q->>'price')::numeric=166.67 and q->>'rate_path'='via_kzt',
  'KG list 2 EUR to RUB through tenge on one date: 2 * 500 / 6 = 166.666... -> 166.67';
 q:=pg_temp.q('4','1','2026-06-14');
 assert (q->>'price')::numeric=2.4 and (q->>'rate_date')::date='2026-06-10','no rate on the day: the latest within 7 days, with its date';
 q:=pg_temp.q('3','1','2026-06-20');
 assert q->'price'='null'::jsonb and q->>'reason'='no_rate','only a bank RUB rate on 2026-06-20 and the official one is 10 days old: no price';
end $$;

-- 6. A fixed price of the customer wins over the percent; it ends with a null price from a date.
reset role;
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000002',true);
set local role authenticated;
select public.set_customer_fixed_price('d1100000-0000-4000-8000-000000000002','d1200000-0000-4000-8000-000000000001',950,pg_temp.c('KZT'),'2026-06-05','Спеццена по договору');
select public.set_customer_fixed_price('d1100000-0000-4000-8000-000000000002','d1200000-0000-4000-8000-000000000001',null,pg_temp.c('KZT'),'2026-06-12','Спеццена закончилась');
do $$begin
 assert (pg_temp.q('2','1','2026-06-10')->>'price')::numeric=950 and pg_temp.q('2','1','2026-06-10')->>'source'='fixed','fixed price wins over +10 %';
 assert (pg_temp.q('2','1','2026-06-10','box')->>'price')::numeric=11400,'fixed price per box: 950 * 12';
 assert (pg_temp.q('2','1','2026-06-12')->>'price')::numeric=1100,'after the fixed price ends: back to price list +10 %';
end $$;
reset role;

-- 7. A manual correction survives the next import; a changed sheet price against it needs a decision.
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000001',true);
set local role authenticated;
select pg_temp.fails($q$select public.set_price_list_price(gen_random_uuid(),pg_temp.t('kz_prepayment'),'d1200000-0000-4000-8000-000000000002',2100,'2026-06-10','  ')$q$,'причину');
select public.set_price_list_price('d1300000-0000-4000-8000-000000000002',pg_temp.t('kz_prepayment'),'d1200000-0000-4000-8000-000000000002',2100,'2026-06-10','Согласовано с сетью');
reset role;
-- The sheet changes: Trolli 2000 -> 2050 (conflicts with the manual 2100), the no-brand product 300 -> 350 (plain change).
update public.product_master_data set sales_data=jsonb_set(sales_data,'{source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2}','2050') where product_id='d1200000-0000-4000-8000-000000000002';
update public.product_master_data set sales_data=jsonb_set(sales_data,'{source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2}','350') where product_id='d1200000-0000-4000-8000-000000000003';
set local role authenticated;
insert into d1 select 'p2',public.price_list_import_preview('2026-06-11');
do $$
declare p jsonb:=(select v from d1 where k='p2');
begin
 assert (select r->>'status' from jsonb_array_elements(p->'rows') r where r->>'sku'='D1-B' and r->>'price_type'='kz_prepayment')='conflict';
 assert (select r->>'sheet_value'='2050' and r->>'current_price'='2100.0000' and r->>'current_origin'='manual'
   from jsonb_array_elements(p->'rows') r where r->>'sku'='D1-B' and r->>'price_type'='kz_prepayment'),'shown as "sheet 2050, corrected in Nexus to 2100"';
 assert (select r->>'status' from jsonb_array_elements(p->'rows') r where r->>'sku'='D1-NOBRAND')='changed';
end $$;
select pg_temp.fails(format('select public.confirm_price_list_import(%L,%L,%L,%L)',gen_random_uuid(),(select v->>'stamp' from d1 where k='p2'),'2026-06-11','{}'),'Выберите, что оставить');
select pg_temp.fails(format('select public.confirm_price_list_import(%L,%L,%L,%L)',gen_random_uuid(),repeat('0',64),'2026-06-11','{}'),'изменились после предпросмотра');
select public.confirm_price_list_import('d1300000-0000-4000-8000-000000000003',(select v->>'stamp' from d1 where k='p2'),'2026-06-11',
 jsonb_build_object('kz_prepayment:d1200000-0000-4000-8000-000000000002','keep_manual'));
do $$begin
 assert (pg_temp.q('2','2','2026-06-12')->>'price')::numeric=1995,'manual 2100 kept: 2100 * 0.95 = 1995.00';
 assert (pg_temp.q('2','3','2026-06-12')->>'note')='brand_missing','the no-brand product still has no percent';
end $$;
reset role;
do $$begin
 assert (select price=350 from private.price_on(pg_temp.t('kz_prepayment'),'d1200000-0000-4000-8000-000000000003','2026-06-12')),'plain change applied';
 assert (select count(*) from public.price_list_entries where product_id='d1200000-0000-4000-8000-000000000002')=2,'no silent overwrite of the manual price';
end $$;
-- Next import still shows the same conflict as "kept_manual" only if the sheet did not change again; take the sheet now.
set local role authenticated;
insert into d1 select 'p3',public.price_list_import_preview('2026-06-13');
select public.confirm_price_list_import('d1300000-0000-4000-8000-000000000004',(select v->>'stamp' from d1 where k='p3'),'2026-06-13',
 jsonb_build_object('kz_prepayment:d1200000-0000-4000-8000-000000000002','take_sheet'));
do $$begin
 assert (pg_temp.q('2','2','2026-06-13')->>'price')::numeric=1947.5,'sheet 2050 taken: 2050 * 0.95 = 1947.50';
 assert (pg_temp.q('2','2','2026-06-12')->>'price')::numeric=1995,'the earlier date keeps the manual price';
end $$;
reset role;

-- 8. A changed sheet structure stops the import.
update public.product_master_sources set columns=(select jsonb_agg(case when c->>'key'='source.установленные_цены.цп_лента'
  then jsonb_set(c,'{position}','90') else c end) from jsonb_array_elements(columns) c) where source_key='arseo-master-calculator';
set local role authenticated;
do $$begin
 assert (public.price_list_import_preview('2026-06-14')->>'reason')='structure_changed';
end $$;
reset role;

-- 9. Rights: a logistics specialist reads the price list but changes nothing; personal deny wins over the role.
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000003',true);
set local role authenticated;
do $$begin
 assert jsonb_array_length(public.price_list('2026-06-12')->'products')>0;
 assert public.price_list('2026-06-12')::text !~ 'себестоим|маржа|расчетн','the price list returns no cost, margin or calculated prices';
end $$;
select pg_temp.fails($q$select public.price_list_import_preview(null)$q$,'Нет права изменять прайс');
select pg_temp.fails($q$select public.set_customer_price_terms('d1100000-0000-4000-8000-000000000002',pg_temp.t('kz_prepayment'),pg_temp.c('KZT'),'2026-07-01','Попытка')$q$,'Нет права изменять условия');
select pg_temp.fails($q$select * from public.price_list_entries$q$,'permission denied');
select pg_temp.fails($q$insert into public.customer_brand_markups(customer_id,brand_id,percent,valid_from,reason,created_by) values('d1100000-0000-4000-8000-000000000002',gen_random_uuid(),1,'2026-07-01','x x x',auth.uid())$q$,'permission denied');
reset role;
select set_config('request.jwt.claim.sub','d1000000-0000-4000-8000-000000000004',true);
set local role authenticated;
select pg_temp.fails($q$select public.set_price_list_price(gen_random_uuid(),pg_temp.t('kz_prepayment'),'d1200000-0000-4000-8000-000000000001',1,'2026-06-01','Попытка')$q$,'Нет права изменять прайс');
select pg_temp.fails($q$select public.set_customer_brand_markup('d1100000-0000-4000-8000-000000000002',(select (v#>>'{}')::uuid from d1 where k='brand_a'),1,'2026-07-01','Попытка')$q$,'Нет права изменять условия');
reset role;

-- 10. History is never edited, even by the owner of the database.
select pg_temp.fails($q$update public.price_list_entries set price=1$q$,'неизменяема');
select pg_temp.fails($q$delete from public.customer_brand_markups$q$,'неизменяема');
do $$begin
 assert not has_function_privilege('anon','public.customer_price_quote(uuid,uuid,text,date,uuid)','execute');
 assert not has_function_privilege('authenticated','private.resolve_customer_price(uuid,uuid,text,date,uuid)','execute');
 assert (select count(*) from public.role_permissions rp join public.permissions p on p.id=rp.permission_id join public.app_roles r on r.id=rp.role_id
   where p.code='pricing.list.manage' and rp.granted)=1,'only the administrator manages the price list';
end $$;
rollback;
\echo sales_price_list: all checks passed
