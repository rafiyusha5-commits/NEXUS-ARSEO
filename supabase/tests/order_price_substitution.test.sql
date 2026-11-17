-- 202611170200: order lines are priced from the price list; manual price only with a reason; commercial program
-- price only for the agreed quantity. Synthetic data only; everything is rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('d2000000-0000-4000-8000-000000000001','order-price@example.invalid','{"full_name":"Order price operator"}');
insert into public.user_roles(user_id,role_id) select 'd2000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id,min_remaining_shelf_life_pct) values
 ('d2100000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Order price supplier','FI','D2-SUP',null),
 ('d2100000-0000-4000-8000-000000000002',array['customer'],'Сеть с условиями','KZ','D2-KZ',60),
 ('d2100000-0000-4000-8000-000000000003',array['customer'],'Клиент без условий','KZ','D2-NONE',null);
insert into public.warehouses(id,code,name,city,country) values
 ('d2300000-0000-4000-8000-000000000001','D2-WH','{"ru":"Склад цен"}','Almaty','KZ');
insert into public.products(id,internal_sku,name,manufacturer_id,brand,status) values
 ('d2200000-0000-4000-8000-000000000001','D2-A','{"ru":"Товар с ценой"}','d2100000-0000-4000-8000-000000000001','D2 Brand','active'),
 ('d2200000-0000-4000-8000-000000000002','D2-B','{"ru":"Товар без цены"}','d2100000-0000-4000-8000-000000000001','D2 Brand','active');
insert into public.product_packaging(product_id,uom,units_per_parent) values ('d2200000-0000-4000-8000-000000000001','box',6);
insert into public.brands(id,name,brand_key,created_by) values
 ('d2400000-0000-4000-8000-000000000001','D2 Brand',private.brand_key('D2 Brand'),'d2000000-0000-4000-8000-000000000001');
insert into public.price_list_entries(price_type_id,product_id,price,valid_from,origin,reason,created_by)
 select id,'d2200000-0000-4000-8000-000000000001',250,'2020-01-01','manual','Синтетическая цена','d2000000-0000-4000-8000-000000000001'
 from public.price_types where code='kz_prepayment';
insert into public.customer_price_terms(customer_id,price_type_id,contract_currency_id,valid_from,reason,created_by)
 select 'd2100000-0000-4000-8000-000000000002',(select id from public.price_types where code='kz_prepayment'),id,'2020-01-01','Договор','d2000000-0000-4000-8000-000000000001'
 from public.currencies where code='KZT';
insert into public.customer_brand_markups(customer_id,brand_id,percent,valid_from,reason,created_by) values
 ('d2100000-0000-4000-8000-000000000002','d2400000-0000-4000-8000-000000000001',-10,'2020-01-01','Скидка','d2000000-0000-4000-8000-000000000001');

create temporary table d2(k text primary key,id uuid);
grant all on d2 to authenticated;
create function pg_temp.kzt() returns uuid language sql stable security definer as $$ select id from public.currencies where code='KZT' $$;
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;
select set_config('request.jwt.claim.sub','d2000000-0000-4000-8000-000000000001',true);
set local role authenticated;
insert into d2 values
 ('sale',public.create_customer_order('d2100000-0000-4000-8000-000000000002',null,'d2300000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null)),
 ('no_currency',public.create_customer_order('d2100000-0000-4000-8000-000000000002',null,'d2300000-0000-4000-8000-000000000001',current_date+5,null,null)),
 ('no_terms',public.create_customer_order('d2100000-0000-4000-8000-000000000003',null,'d2300000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null));

-- 1. No price given: the price list price with the customer's -10 % for the brand, per piece and per box of 6.
insert into d2 values
 ('piece',public.add_customer_order_item((select id from d2 where k='sale'),'d2200000-0000-4000-8000-000000000001',3,'piece',null,null)),
 ('box',public.add_customer_order_item((select id from d2 where k='sale'),'d2200000-0000-4000-8000-000000000001',2,'box',null,null)),
-- 2. No price in the price list: the line is added without a price and with the reason (warning, not a refusal).
 ('unpriced',public.add_customer_order_item((select id from d2 where k='sale'),'d2200000-0000-4000-8000-000000000002',1,'piece',null,null)),
 ('no_terms_item',public.add_customer_order_item((select id from d2 where k='no_terms'),'d2200000-0000-4000-8000-000000000001',1,'piece',null,null)),
 ('no_currency_item',public.add_customer_order_item((select id from d2 where k='no_currency'),'d2200000-0000-4000-8000-000000000001',1,'piece',null,null));
-- 3. A manual price needs a reason.
select pg_temp.fails($q$select public.add_customer_order_item((select id from d2 where k='no_terms'),'d2200000-0000-4000-8000-000000000002',1,'piece',99,null)$q$,'причину ручной цены');
select pg_temp.fails($q$select public.add_customer_order_item((select id from d2 where k='no_terms'),'d2200000-0000-4000-8000-000000000002',1,'piece',99,null,'  ')$q$,'причину ручной цены');
insert into d2 values ('manual',public.add_customer_order_item((select id from d2 where k='no_terms'),'d2200000-0000-4000-8000-000000000002',1,'piece',99,null,'Цена из письма клиента'));
reset role;
do $$
declare i public.sale_items;
begin
 select * into i from public.sale_items where id=(select id from d2 where k='piece');
 assert i.unit_price=225 and i.price_source='price_list','250 * 0.90 = 225.00 per piece, from the price list';
 assert i.price_snapshot->>'price_type'='kz_prepayment' and i.price_snapshot->>'brand'='D2 Brand' and (i.price_snapshot->>'percent')::numeric=-10
   and (i.price_snapshot->>'vat_included')::boolean and i.price_snapshot->>'rate_path'='same' and i.price_snapshot ? 'rate_date',
   'the line keeps price type, brand, percent, VAT flag and rate details';
 assert i.required_shelf_life_pct=60,'shelf-life requirement still comes from the customer';
 assert (select unit_price from public.sale_items where id=(select id from d2 where k='box'))=1350,'box of 6: 225 * 6 = 1350.00';
 select * into i from public.sale_items where id=(select id from d2 where k='unpriced');
 assert i.unit_price is null and i.price_source='none' and i.price_snapshot->>'reason'='no_price','no price: line kept with the reason';
 assert (select unit_price is null and price_snapshot->>'reason'='no_price_type' from public.sale_items where id=(select id from d2 where k='no_terms_item'));
 assert (select unit_price is null and price_snapshot->>'reason'='order_currency_missing' from public.sale_items where id=(select id from d2 where k='no_currency_item'));
 select * into i from public.sale_items where id=(select id from d2 where k='manual');
 assert i.unit_price=99 and i.price_source='manual' and i.price_reason='Цена из письма клиента'
   and i.price_set_by='d2000000-0000-4000-8000-000000000001' and i.price_snapshot->'price_list_quote'->>'reason'='no_price_type',
   'manual price: reason, author and what the price list would give';
 assert (select amount=675+2700 and unpriced_lines=1 from private.sale_amount((select id from d2 where k='sale'))),'order total counts priced lines; one line without a price';
end $$;
-- A manual line cannot be stored without its reason, even by the database owner.
select pg_temp.fails($q$insert into public.sale_items(sale_id,product_id,quantity,uom,unit_price,price_source) values((select id from d2 where k='no_terms'),'d2200000-0000-4000-8000-000000000001',1,'box',5,'manual')$q$,'sale_items_manual_price_reason_check');

-- 4. Commercial program (special order): target price for the agreed 10 pieces; more units go to a separate line.
insert into public.commercial_programs(id,name,kind,customer_id,version,starts_on,ends_on,status,created_by) values
 ('d2500000-0000-4000-8000-000000000001','Спецзаказ D2','special_order','d2100000-0000-4000-8000-000000000002',1,current_date,current_date+30,'approved','d2000000-0000-4000-8000-000000000001');
insert into public.commercial_program_lines(id,commercial_program_id,product_id,planned_quantity,uom,target_unit_price,currency_id) values
 ('d2600000-0000-4000-8000-000000000001','d2500000-0000-4000-8000-000000000001','d2200000-0000-4000-8000-000000000001',10,'piece',180,pg_temp.kzt()),
 ('d2600000-0000-4000-8000-000000000002','d2500000-0000-4000-8000-000000000001','d2200000-0000-4000-8000-000000000001',1,'box',null,null);
set local role authenticated;
insert into d2 values ('program_sale',public.create_sale_from_commercial_program('d2500000-0000-4000-8000-000000000001','d2300000-0000-4000-8000-000000000001',current_date+5,pg_temp.kzt(),null));
-- Extra units: an ordinary line of the same product and unit next to the program line, at the price-list price.
insert into d2 values ('extra',public.add_customer_order_item((select id from d2 where k='program_sale'),'d2200000-0000-4000-8000-000000000001',5,'piece',null,null));
select pg_temp.fails($q$select public.add_customer_order_item((select id from d2 where k='program_sale'),'d2200000-0000-4000-8000-000000000001',1,'piece',null,null)$q$,'duplicate key|sale_items_ordinary_line_key');
reset role;
do $$
declare i public.sale_items;
begin
 select * into i from public.sale_items where sale_id=(select id from d2 where k='program_sale') and commercial_program_line_id='d2600000-0000-4000-8000-000000000001';
 assert i.unit_price=180 and i.price_source='commercial_program' and i.program_quantity=10 and i.quantity=10
   and i.price_snapshot->>'program'='Спецзаказ D2' and (i.price_snapshot->>'agreed_quantity')::numeric=10,'program price for the agreed quantity';
 select * into i from public.sale_items where sale_id=(select id from d2 where k='program_sale') and commercial_program_line_id='d2600000-0000-4000-8000-000000000002';
 assert i.unit_price=1350 and i.price_source='price_list' and i.program_quantity=1,'program line without a target price is priced from the price list';
 select * into i from public.sale_items where id=(select id from d2 where k='extra');
 assert i.unit_price=225 and i.price_source='price_list' and i.commercial_program_line_id is null,'extra units: separate line, price-list price';
end $$;
-- The program line cannot hold more than the agreed quantity.
select pg_temp.fails($q$update public.sale_items set quantity=11 where commercial_program_line_id='d2600000-0000-4000-8000-000000000001'$q$,'sale_items_program_quantity_check');
select pg_temp.fails($q$select private.add_sale_item((select id from d2 where k='sale'),'d2200000-0000-4000-8000-000000000001',11,'piece',null,null,null,'d2600000-0000-4000-8000-000000000001')$q$,'согласованное количество');

-- 5. Rights: the old six-argument signature is gone, the new one is granted to employees only.
do $$begin
 assert to_regprocedure('public.add_customer_order_item(uuid,uuid,numeric,text,numeric,numeric)') is null;
 assert has_function_privilege('authenticated','public.add_customer_order_item(uuid,uuid,numeric,text,numeric,numeric,text)','execute');
 assert not has_function_privilege('anon','public.add_customer_order_item(uuid,uuid,numeric,text,numeric,numeric,text)','execute');
 assert not has_function_privilege('authenticated','private.add_sale_item(uuid,uuid,numeric,text,numeric,numeric,text,uuid)','execute');
end $$;
rollback;
\echo order_price_substitution: all checks passed
