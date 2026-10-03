-- Purchase-price confidentiality: one permission, personal deny wins, sales prices remain employee data.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.price_expect_error(p_sql text,p_pattern text) returns void language plpgsql as $$begin
 execute p_sql;raise exception 'expected error but statement succeeded' using errcode='P0099';
exception when sqlstate 'P0099' then raise;when others then if sqlerrm!~*p_pattern then raise exception 'expected %, got %',p_pattern,sqlerrm using errcode='P0099';end if;end$$;
create or replace function tests.price_act_as(p_user uuid) returns void language sql as $$select set_config('request.jwt.claim.sub',p_user::text,false)$$;
grant usage on schema tests to authenticated;
grant execute on function tests.price_expect_error(text,text),tests.price_act_as(uuid) to authenticated;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d4100000-0000-4000-8000-000000000001','price-admin@test.local','{"full_name":"Price admin"}'),
 ('d4100000-0000-4000-8000-000000000002','price-specialist@test.local','{"full_name":"Price specialist"}'),
 ('d4100000-0000-4000-8000-000000000003','price-denied@test.local','{"full_name":"Price denied director"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('d4100000-0000-4000-8000-000000000001','administrator'),
 ('d4100000-0000-4000-8000-000000000002','logistics_specialist'),
 ('d4100000-0000-4000-8000-000000000003','director'))u(id,role_code) join public.app_roles r on r.code=u.role_code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'd4100000-0000-4000-8000-000000000003',p.id,'deny','price test','d4100000-0000-4000-8000-000000000001'
from public.permissions p where p.code='prices.purchase.view';

insert into public.counterparties(id,roles,legal_name,country) values
 ('d4100000-0000-4000-8000-000000000011',array['supplier','manufacturer'],'Price supplier','FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status,base_purchase_price) values
 ('d4100000-0000-4000-8000-000000000012','PRICE-1','{"ru":"Товар с ценой"}','d4100000-0000-4000-8000-000000000011','active',123.45);
insert into public.contracts(id,counterparty_id,number,type) values
 ('d4100000-0000-4000-8000-000000000013','d4100000-0000-4000-8000-000000000011','PRICE-C','supply');
insert into public.contract_terms(id,contract_id,term_type,value_numeric,value_text) values
 ('d4100000-0000-4000-8000-000000000014','d4100000-0000-4000-8000-000000000013','price',123.45,null),
 ('d4100000-0000-4000-8000-000000000015','d4100000-0000-4000-8000-000000000013','payment_terms',null,'30 days');
insert into public.shipments(id,shipment_number,type,supplier_id,route_id,process_template_id,currency_id,destination_warehouse_id,responsible_user_id,created_by)
select 'd4100000-0000-4000-8000-000000000016','PRICE-SHIP','import','d4100000-0000-4000-8000-000000000011',
 (select id from public.routes limit 1),(select id from public.process_templates limit 1),(select id from public.currencies where code='EUR'),
 (select id from public.warehouses where code='AKT'),'d4100000-0000-4000-8000-000000000002','d4100000-0000-4000-8000-000000000001';
insert into public.shipment_items(id,shipment_id,product_id,uom,ordered_quantity,unit_price,currency_id)
select 'd4100000-0000-4000-8000-000000000017','d4100000-0000-4000-8000-000000000016','d4100000-0000-4000-8000-000000000012','piece',10,9.99,id from public.currencies where code='EUR';

set role authenticated;
select tests.price_act_as('d4100000-0000-4000-8000-000000000002');
do $$begin
 assert (select count(*) from public.products where id='d4100000-0000-4000-8000-000000000012')=1,'specialist still sees product';
 assert (select count(*) from public.contract_terms where contract_id='d4100000-0000-4000-8000-000000000013')=1,'specialist sees non-price term only';
 assert not has_column_privilege('authenticated','public.products','base_purchase_price','select'),'purchase column not directly selectable';
 assert not has_column_privilege('authenticated','public.shipment_items','unit_price','select'),'shipment purchase column not directly selectable';
 assert has_column_privilege('authenticated','public.sale_items','unit_price','select'),'sales prices remain available to employees';
 perform tests.price_expect_error($q$select * from public.my_product_purchase_prices(array['d4100000-0000-4000-8000-000000000012'::uuid])$q$,'Нет доступа');
 perform tests.price_expect_error($q$select public.create_shipment_item('d4100000-0000-4000-8000-000000000016','d4100000-0000-4000-8000-000000000012','piece',1,1.23,null)$q$,'Нет права');
end$$;

select tests.price_act_as('d4100000-0000-4000-8000-000000000001');
do $$begin
 assert (select base_purchase_price=123.45 from public.my_product_purchase_prices(array['d4100000-0000-4000-8000-000000000012'::uuid])),'administrator sees product purchase price';
 assert (select unit_price=9.99 from public.my_shipment_item_purchase_prices('d4100000-0000-4000-8000-000000000016')),'administrator sees shipment purchase price';
 assert (select count(*) from public.contract_terms where contract_id='d4100000-0000-4000-8000-000000000013')=2,'administrator sees price and non-price terms';
end$$;

select tests.price_act_as('d4100000-0000-4000-8000-000000000003');
select tests.price_expect_error($q$select * from public.my_product_purchase_prices(array['d4100000-0000-4000-8000-000000000012'::uuid])$q$,'Нет доступа');
select tests.price_expect_error($q$select public.allocate_expense('d4100000-0000-4000-8000-000000000099','by_quantity',null)$q$,'Нет доступа к себестоимости');
select tests.price_expect_error($q$select public.calculate_shipment_cost('d4100000-0000-4000-8000-000000000016',null)$q$,'Нет доступа к себестоимости');
select tests.price_expect_error($q$select public.approve_shipment_cost('d4100000-0000-4000-8000-000000000099')$q$,'Нет доступа к себестоимости');
reset role;
