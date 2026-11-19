-- 202611180100: no confirmation while a line has no price; recalculate a line from the price list or set its price
-- by hand with a reason, with an append-only history; a product without a brand gets the price list price without
-- percent. Synthetic data only; everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ac100000-0000-4000-8000-000000000001','line-price@example.invalid','{"full_name":"Line price operator"}'),
 ('ac100000-0000-4000-8000-000000000002','line-price-acc@example.invalid','{"full_name":"Line price accountant"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values
 ('ac100000-0000-4000-8000-000000000001'::uuid,'director'),('ac100000-0000-4000-8000-000000000002'::uuid,'accountant')) u(id,code)
 join public.app_roles r on r.code=u.code;
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ac110000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Line price supplier','FI','AC1-SUP'),
 ('ac110000-0000-4000-8000-000000000002',array['customer'],'Клиент цен строк','KZ','AC1-KZ');
insert into public.warehouses(id,code,name,city,country) values
 ('ac130000-0000-4000-8000-000000000001','AC1-WH','{"ru":"Склад цен строк"}','Almaty','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,brand,status) values
 ('ac120000-0000-4000-8000-000000000001','AC1-A','{"ru":"Товар с брендом"}','ac110000-0000-4000-8000-000000000001','AC1 Brand','active'),
 ('ac120000-0000-4000-8000-000000000002','AC1-B','{"ru":"Товар, цена позже"}','ac110000-0000-4000-8000-000000000001','AC1 Brand','active'),
 ('ac120000-0000-4000-8000-000000000003','AC1-C','{"ru":"Товар без бренда"}','ac110000-0000-4000-8000-000000000001',null,'active');
insert into public.brands(id,name,brand_key,created_by) values
 ('ac140000-0000-4000-8000-000000000001','AC1 Brand',private.brand_key('AC1 Brand'),'ac100000-0000-4000-8000-000000000001');
insert into public.price_list_entries(price_type_id,product_id,price,valid_from,origin,reason,created_by)
 select t.id,p.id,p.price,'2020-01-01','manual','Синтетическая цена','ac100000-0000-4000-8000-000000000001'
 from public.price_types t cross join (values ('ac120000-0000-4000-8000-000000000001'::uuid,200),('ac120000-0000-4000-8000-000000000003'::uuid,300)) p(id,price)
 where t.code='kz_prepayment';
insert into public.customer_price_terms(customer_id,price_type_id,contract_currency_id,valid_from,reason,created_by)
 select 'ac110000-0000-4000-8000-000000000002',(select id from public.price_types where code='kz_prepayment'),id,'2020-01-01','Договор','ac100000-0000-4000-8000-000000000001'
 from public.currencies where code='KZT';
insert into public.customer_brand_markups(customer_id,brand_id,percent,valid_from,reason,created_by) values
 ('ac110000-0000-4000-8000-000000000002','ac140000-0000-4000-8000-000000000001',10,'2020-01-01','Наценка','ac100000-0000-4000-8000-000000000001');

create temporary table ac(k text primary key,id uuid);
grant all on ac to authenticated;
create function pg_temp.kzt() returns uuid language sql stable security definer as $$ select id from public.currencies where code='KZT' $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
create function pg_temp.line(p_k text) returns public.sale_items language sql stable security definer as $$
 select * from public.sale_items where id=(select id from ac where k=p_k) $$;
grant execute on all functions in schema pg_temp to authenticated;
select set_config('request.jwt.claim.sub','ac100000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into ac values
 ('sale',public.create_customer_order('ac110000-0000-4000-8000-000000000002',null,'ac130000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null));
insert into ac values
 ('a',public.add_customer_order_item((select id from ac where k='sale'),'ac120000-0000-4000-8000-000000000001',2,'piece',null,null)),
 ('b',public.add_customer_order_item((select id from ac where k='sale'),'ac120000-0000-4000-8000-000000000002',1,'piece',null,null)),
 ('c',public.add_customer_order_item((select id from ac where k='sale'),'ac120000-0000-4000-8000-000000000003',1,'piece',null,null));
reset role;

-- 1. A product without a brand in the directory: price list price without percent, noted brand_missing.
do $$begin
 assert (pg_temp.line('a')).unit_price=220,'brand with +10 %: 200 * 1.10';
 assert (pg_temp.line('c')).unit_price=300 and (pg_temp.line('c')).price_source='price_list'
   and (pg_temp.line('c')).price_snapshot->>'note'='brand_missing' and (pg_temp.line('c')).price_snapshot->'percent'='null'::jsonb,
   'no brand: 300 without percent, noted';
 assert (pg_temp.line('b')).unit_price is null and (pg_temp.line('b')).price_snapshot->>'reason'='no_price','B has no price yet';
end $$;

-- 2. No confirmation while a line has no price, through the real confirmation.
update public.sales set status='reserved' where id=(select id from ac where k='sale');
set local role authenticated;
select pg_temp.fails($q$select public.confirm_customer_order((select id from ac where k='sale'))$q$,'позиций без цены — 1');
reset role;
do $$begin
 assert (select status from public.sales where id=(select id from ac where k='sale'))='reserved','the order stays reserved';
end $$;

-- 3. Recalculate from the price list: still no price -> nothing changes and the answer says why.
set local role authenticated;
do $$declare r jsonb;begin
 r:=public.reprice_customer_order_item((select id from ac where k='b'));
 assert not (r->>'changed')::boolean and r->'quote'->>'reason'='no_price','no price yet: unchanged, with the reason';
end $$;
reset role;
do $$begin
 assert (pg_temp.line('b')).unit_price is null and (pg_temp.line('b')).price_snapshot->>'reason'='no_price'
   and not exists(select 1 from public.sale_item_price_changes where sale_item_id=(select id from ac where k='b')),
   'still no price: no history row';
end $$;
-- The price appears later in the price list; recalculation takes it (+10 % for the brand) and keeps a history row.
insert into public.price_list_entries(price_type_id,product_id,price,valid_from,origin,reason,created_by)
 select id,'ac120000-0000-4000-8000-000000000002',500,'2020-01-01','manual','Цена появилась позже','ac100000-0000-4000-8000-000000000001'
 from public.price_types where code='kz_prepayment';
set local role authenticated;
do $$declare r jsonb;begin
 r:=public.reprice_customer_order_item((select id from ac where k='b'));
 assert (r->>'changed')::boolean and (r->'quote'->>'price')::numeric=550,'500 * 1.10 = 550';
 -- A repeated click changes nothing and records nothing.
 r:=public.reprice_customer_order_item((select id from ac where k='b'));
 assert not (r->>'changed')::boolean,'the same price again: no change';
end $$;
reset role;
do $$declare h public.sale_item_price_changes;begin
 assert (pg_temp.line('b')).unit_price=550 and (pg_temp.line('b')).price_source='price_list' and (pg_temp.line('b')).price_snapshot->>'brand'='AC1 Brand';
 assert (select count(*) from public.sale_item_price_changes where sale_item_id=(select id from ac where k='b'))=1,'one history row';
 select * into h from public.sale_item_price_changes where sale_item_id=(select id from ac where k='b');
 assert h.kind='recalculated' and h.previous_price is null and h.previous_source='none' and h.new_price=550 and h.new_source='price_list'
   and h.reason is null and h.changed_by='ac100000-0000-4000-8000-000000000001' and h.sale_id=(select id from ac where k='sale'),
   'history: was nothing, became 550 from the price list, who';
end $$;

-- 4. Set by hand: a reason is required; the price list quote of the moment is kept; history row with the reason.
set local role authenticated;
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ac where k='a'),199,null)$q$,'причину ручной цены');
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ac where k='a'),199,'  ')$q$,'причину ручной цены');
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ac where k='a'),-1,'Отрицательная')$q$,'не меньше нуля');
select public.set_customer_order_item_price((select id from ac where k='a'),199,'Цена из письма клиента');
-- The same price and reason again: no second history row.
select public.set_customer_order_item_price((select id from ac where k='a'),199,'Цена из письма клиента');
reset role;
do $$declare h public.sale_item_price_changes;begin
 assert (pg_temp.line('a')).unit_price=199 and (pg_temp.line('a')).price_source='manual' and (pg_temp.line('a')).price_reason='Цена из письма клиента'
   and (pg_temp.line('a')).price_set_by='ac100000-0000-4000-8000-000000000001'
   and ((pg_temp.line('a')).price_snapshot->'price_list_quote'->>'price')::numeric=220,'manual price, reason, author, price list quote kept';
 assert (select count(*) from public.sale_item_price_changes where sale_item_id=(select id from ac where k='a'))=1;
 select * into h from public.sale_item_price_changes where sale_item_id=(select id from ac where k='a');
 assert h.kind='manual' and h.previous_price=220 and h.previous_source='price_list' and h.new_price=199 and h.reason='Цена из письма клиента';
end $$;
-- Recalculating a manual line brings the price list price back, and says so in the history.
set local role authenticated;
select public.reprice_customer_order_item((select id from ac where k='a'));
reset role;
do $$begin
 assert (pg_temp.line('a')).unit_price=220 and (pg_temp.line('a')).price_source='price_list' and (pg_temp.line('a')).price_reason is null
   and (pg_temp.line('a')).price_set_by is null,'back to the price list';
 assert (select count(*) from public.sale_item_price_changes where sale_item_id=(select id from ac where k='a'))=2;
end $$;

-- 5. All lines priced: the order is confirmed.
set local role authenticated;
select public.confirm_customer_order((select id from ac where k='sale'));
-- 6. After confirmation the price is not changed any more.
select pg_temp.fails($q$select public.reprice_customer_order_item((select id from ac where k='a'))$q$,'только в черновике или зарезервированном');
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ac where k='a'),1,'Поздно менять')$q$,'только в черновике или зарезервированном');
reset role;
do $$begin
 assert (select status from public.sales where id=(select id from ac where k='sale'))='confirmed';
 assert (pg_temp.line('a')).unit_price=220,'confirmed price unchanged';
end $$;

-- 7. Rights: the accountant sees the history but cannot change a price; nobody edits or deletes the history.
select set_config('request.jwt.claim.sub','ac100000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$begin
 assert (select count(*) from public.sale_item_price_changes where sale_id=(select id from ac where k='sale'))=3,'sales.view sees the history';
end $$;
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ac where k='c'),1,'Без права')$q$,'Нет права изменять клиентские заказы');
select pg_temp.fails($q$select public.reprice_customer_order_item((select id from ac where k='c'))$q$,'Нет права изменять клиентские заказы');
select pg_temp.fails($q$insert into public.sale_item_price_changes(sale_item_id,sale_id,kind,new_price,new_source,changed_by)
 values((select id from ac where k='c'),(select id from ac where k='sale'),'recalculated',1,'price_list',auth.uid())$q$,'permission denied');
reset role;
select pg_temp.fails($q$update public.sale_item_price_changes set new_price=1$q$,'неизменяема');
select pg_temp.fails($q$delete from public.sale_item_price_changes$q$,'неизменяема');
do $$begin
 assert not has_function_privilege('anon','public.reprice_customer_order_item(uuid)','execute');
 assert not has_function_privilege('anon','public.set_customer_order_item_price(uuid,numeric,text)','execute');
 assert not has_table_privilege('anon','public.sale_item_price_changes','select');
 assert not has_table_privilege('authenticated','public.sale_item_price_changes','insert');
end $$;

-- 8. A commercial program price is changed in the program, not in the order (line stored as the program stores it).
select set_config('request.jwt.claim.sub','ac100000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into ac values
 ('sale2',public.create_customer_order('ac110000-0000-4000-8000-000000000002',null,'ac130000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null));
reset role;
with i as (insert into public.sale_items(sale_id,product_id,quantity,uom,unit_price,price_source,price_snapshot)
 values((select id from ac where k='sale2'),'ac120000-0000-4000-8000-000000000003',1,'piece',10,'commercial_program','{}') returning id)
insert into ac select 'program',id from i;
set local role authenticated;
select pg_temp.fails($q$select public.set_customer_order_item_price((select id from ac where k='program'),1,'Своя цена')$q$,'Цена программы');
select pg_temp.fails($q$select public.reprice_customer_order_item((select id from ac where k='program'))$q$,'Цена программы');
reset role;
\echo order_line_prices: all checks passed
rollback;
