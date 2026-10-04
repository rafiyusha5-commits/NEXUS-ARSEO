-- Full calculator snapshots: atomic dry-run, exact source schema and protected commercial data.
\set ON_ERROR_STOP 1

create schema if not exists tests;
create or replace function tests.calc_act_as(p_user uuid) returns void language sql as $$select set_config('request.jwt.claim.sub',p_user::text,false)$$;
create or replace function tests.calc_expect_error(p_sql text,p_pattern text) returns void language plpgsql as $$begin
 execute p_sql;raise exception 'expected error but statement succeeded' using errcode='P0099';
exception when sqlstate 'P0099' then raise;when others then if sqlerrm!~*p_pattern then raise exception 'expected %, got %',p_pattern,sqlerrm using errcode='P0099';end if;end$$;
grant usage on schema tests to authenticated;
grant execute on function tests.calc_act_as(uuid),tests.calc_expect_error(text,text) to authenticated;

insert into auth.users(id,email,raw_user_meta_data) values
 ('d4300000-0000-4000-8000-000000000001','calculator-admin@test.local','{"full_name":"Calculator admin"}'),
 ('d4300000-0000-4000-8000-000000000002','calculator-denied@test.local','{"full_name":"Calculator denied"}');
insert into public.user_roles(user_id,role_id)
select u.id::uuid,r.id from (values
 ('d4300000-0000-4000-8000-000000000001','administrator'),
 ('d4300000-0000-4000-8000-000000000002','director'))u(id,role_code) join public.app_roles r on r.code=u.role_code;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
select 'd4300000-0000-4000-8000-000000000002',p.id,'deny','calculator test','d4300000-0000-4000-8000-000000000001'
from public.permissions p where p.code='prices.purchase.view';

create table if not exists tests.calculator_packages(name text primary key,payload jsonb not null);
insert into tests.calculator_packages(name,payload) values('base',$json${
 "format":"nexus-calculator-import","version":1,
 "reference":{"format":"nexus-reference-import","version":1,"counterparties":[
  {"row":6,"ref":"Calculator Oy","legal_name":"Calculator Oy","roles":["manufacturer","supplier"],"country":"FI"}
 ],"products":[
  {"row":6,"internal_sku":"CALC-1","name":{"ru":"Товар калькулятора"},"manufacturer":"Calculator Oy","identifiers":[],"packaging":[]}
 ]},
 "source":{"key":"arseo-master-calculator","title":"Master.xlsx","sheet_name":"расчеты","header_rows":5,"header_fingerprint":"schema-v1","columns":[
  {"key":"product.category","position":83,"source_number":null,"source_code":null,"block":null,"field_en":null,"field_ru":"Категория товаров","visibility":"catalog"},
  {"key":"source.установленные_цены.цп","position":70,"source_number":"64","source_code":null,"block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","field_en":null,"field_ru":"ЦП","visibility":"sales"},
  {"key":"source.информация_о_закупе.цена","position":44,"source_number":"38","source_code":"8","block":"Информация о закупе","field_en":null,"field_ru":"Цена за единицу","visibility":"confidential"}
 ],"rows":[
  {"row":6,"internal_sku":"CALC-1","category":"Конфеты","catalog_data":{"product.category":"Конфеты"},"sales_data":{"source.установленные_цены.цп":1000},"confidential_data":{"source.информация_о_закупе.цена":1.25}}
 ]}
}$json$) on conflict(name) do update set payload=excluded.payload;
grant select on tests.calculator_packages to authenticated;

set role authenticated;
select tests.calc_act_as('d4300000-0000-4000-8000-000000000001');
do $$declare r jsonb;begin
 r:=public.import_calculator_master_data((select payload from tests.calculator_packages where name='base'),true);
 assert r->'master_data'->>'applied'='false','dry-run report';
 assert not exists(select 1 from public.products where internal_sku='CALC-1'),'dry-run rolls back core product';
 assert not exists(select 1 from public.product_master_sources where source_key='arseo-master-calculator'),'dry-run writes no schema';
 r:=public.import_calculator_master_data((select payload from tests.calculator_packages where name='base'),false);
 assert r->'master_data'->>'applied'='true','apply report';
 assert (select category='Конфеты' from public.products where internal_sku='CALC-1'),'category copied to operational catalogue';
 assert (select catalog_data->>'product.category'='Конфеты' and sales_data->>'source.установленные_цены.цп'='1000'
   from public.product_master_data where product_id=(select id from public.products where internal_sku='CALC-1')),'catalogue and sales snapshot saved';
 assert not has_column_privilege('authenticated','public.product_master_data','confidential_data','select'),'closed values have no direct column grant';
 assert not has_table_privilege('authenticated','public.product_master_sources','select'),'full source schema is not directly selectable';
 assert (select jsonb_array_length(columns)=3 from public.my_product_master_sources(array['arseo-master-calculator'])),'administrator sees complete source schema';
 assert (select confidential_data->>'source.информация_о_закупе.цена'='1.25' from public.my_product_master_confidential_data(
   array[(select id from public.products where internal_sku='CALC-1')])),'administrator reads closed data through guarded RPC';
end$$;
select tests.calc_expect_error($q$select public.import_calculator_master_data(
 jsonb_set((select payload from tests.calculator_packages where name='base'),'{source,header_fingerprint}','"changed"'),true)$q$,'Структура листа');

select tests.calc_act_as('d4300000-0000-4000-8000-000000000002');
do $$begin assert (select jsonb_array_length(columns)=2 from public.my_product_master_sources(array['arseo-master-calculator'])),'price-denied user sees only public and sales headers';end$$;
select tests.calc_expect_error($q$select * from public.my_product_master_confidential_data(null)$q$,'Нет доступа');
select tests.calc_expect_error($q$select public.import_calculator_master_data((select payload from tests.calculator_packages where name='base'),true)$q$,'Нет доступа');
reset role;

