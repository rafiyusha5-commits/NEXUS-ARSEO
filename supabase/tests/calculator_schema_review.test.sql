-- Synthetic only; restores all fixtures and source metadata at the end.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('e8610000-0000-4000-8000-000000000001','schema-review@test.local','{"full_name":"Schema review"}'),
 ('e8610000-0000-4000-8000-000000000002','schema-denied@test.local','{"full_name":"Schema denied"}');
insert into public.user_roles(user_id,role_id)
 select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in ('e8610000-0000-4000-8000-000000000001','e8610000-0000-4000-8000-000000000002') and r.code='administrator';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e8610000-0000-4000-8000-000000000002',id,'deny','Synthetic denial','e8610000-0000-4000-8000-000000000001'
 from public.permissions where code='prices.purchase.view';
create temporary table calc_schema_fixture as select $j${
 "key":"arseo-master-calculator","title":"Synthetic calculator","sheet_name":"расчеты","header_rows":5,
 "header_fingerprint":"schema-review-old","rows":[],"columns":[
 {"key":"product.category","field_ru":"Категория товаров","block":null,"visibility":"catalog","position":1},
 {"key":"source.установленные_цены.цена","field_ru":"Цена","block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"sales","position":2},
 {"key":"source.установленные_цены.маржа","field_ru":"Маржа","block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"confidential","position":3}
 ]}$j$::jsonb old_source,
 $j$[
 {"key":"source.установленные_цены.новая_маржа","field_ru":"Новая маржа","block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"confidential","position":4},
 {"key":"source.установленные_цены.новая_цена","field_ru":"Новая цена","block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"sales","position":5}
 ]$j$::jsonb additions;
alter table calc_schema_fixture add column new_source jsonb;
update calc_schema_fixture set new_source=jsonb_set(jsonb_set(old_source,'{header_fingerprint}','"schema-review-new"'),'{columns}',(old_source->'columns')||additions);
insert into public.product_master_sources(source_key,title,sheet_name,header_fingerprint,columns)
 select old_source->>'key','Synthetic calculator','расчеты',old_source->>'header_fingerprint',old_source->'columns' from calc_schema_fixture
 on conflict(source_key) do update set header_fingerprint=excluded.header_fingerprint,columns=excluded.columns;
create temporary table calc_schema_before as select
 (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.products p) products,
 (select coalesce(jsonb_agg(to_jsonb(p) order by p.product_id,p.source_key),'[]') from public.product_master_data p) snapshots,
 (select count(*) from private.calculator_schema_approvals) approvals;
grant select on calc_schema_fixture to authenticated;
create function pg_temp.schema_error(q text, code text) returns void language plpgsql as $$
begin execute q;raise exception 'Expected failure' using errcode='P0099';
exception when others then if sqlstate<>code then raise exception 'Expected %, got %: %',code,sqlstate,sqlerrm;end if;end $$;
create function pg_temp.schema_package(s jsonb) returns jsonb language sql as $$
 select jsonb_build_object('format','nexus-calculator-import','version',1,'reference',$j${
  "format":"nexus-reference-import","version":1,"counterparties":[
   {"row":6,"ref":"Schema Factory","legal_name":"Schema Factory","roles":["manufacturer","supplier"],"country":"FI"}],
  "products":[{"row":6,"internal_sku":"SCHEMA-REVIEW-1","name":{"ru":"Проверка структуры"},"manufacturer":"Schema Factory","identifiers":[],"packaging":[]}]}
 $j$::jsonb,'source',s||jsonb_build_object('rows',$j$[{
  "row":6,"internal_sku":"SCHEMA-REVIEW-1","category":"Тест","catalog_data":{},
  "sales_data":{"source.установленные_цены.новая_цена":100},"confidential_data":{"source.установленные_цены.новая_маржа":42}}]$j$::jsonb));
$$;
set role authenticated;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000001',true);
do $$declare s jsonb;r jsonb;p jsonb;token text;begin
 select new_source into s from calc_schema_fixture;
 r:=public.review_calculator_schema(s);
 assert r->>'status'='approval_required' and jsonb_array_length(r->'added')=2;
 token:=r->>'expected_schema';assert length(token)=64;
 p:=pg_temp.schema_package(s);
 perform pg_temp.schema_error(format('select public.import_calculator_master_data(%L,false)',p),'NX409');
 perform pg_temp.schema_error(format('select public.review_calculator_schema(%L,true,%L)',s,repeat('0',64)),'NX409');
 -- Forging the old fingerprint cannot bypass comparing actual column identities.
 perform pg_temp.schema_error(format('select public.import_calculator_master_data(%L,false)',
  jsonb_set(p,'{source,header_fingerprint}','"schema-review-old"')),'NX409');
 r:=public.review_calculator_schema(s,true,token);assert r->>'status'='approved';
 r:=public.review_calculator_schema(s,true,token);assert r->>'status'='unchanged','retry is idempotent';
 r:=public.import_calculator_master_data(p,true);assert r->'master_data'->>'applied'='false';
 -- Each change that could expose or orphan existing data is blocked.
 for s in select jsonb_set(new_source,'{columns,2,visibility}','"sales"') from calc_schema_fixture
  union all select jsonb_set(new_source,'{columns}',(new_source->'columns')-2) from calc_schema_fixture
  union all select jsonb_set(new_source,'{columns,0,field_ru}','"Другое поле"') from calc_schema_fixture
  union all select jsonb_set(new_source,'{columns,0,key}','"other"') from calc_schema_fixture
 loop
  r:=public.review_calculator_schema(s);assert r->>'status'='blocked';
  perform pg_temp.schema_error(format('select public.review_calculator_schema(%L,true,%L)',s,r->>'expected_schema'),'NX409');
 end loop;
 select new_source into s from calc_schema_fixture;
 s:=jsonb_set(s,'{columns}',(s->'columns')||'{"key":"source.установленные_цены.ещё_маржа","field_ru":"Ещё маржа","position":6,"block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"sales"}'::jsonb);
 r:=public.review_calculator_schema(s);assert r->>'status'='blocked','a new margin cannot become a sales field';
 perform pg_temp.schema_error(format('select public.review_calculator_schema(%L,true,%L)',s,r->>'expected_schema'),'NX409');
 -- Malformed columns and duplicate keys do not get an approval token.
 perform pg_temp.schema_error(format('select public.review_calculator_schema(%L)',jsonb_set(s,'{columns}','[{}]')),'22023');
 perform pg_temp.schema_error(format('select public.review_calculator_schema(%L)',jsonb_set(s,'{columns}',jsonb_build_array(s->'columns'->0,s->'columns'->0))),'P0001');
end $$;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000002',true);
select pg_temp.schema_error('select public.review_calculator_schema((select new_source from calc_schema_fixture))','42501');
select pg_temp.schema_error('select public.review_calculator_schema((select new_source from calc_schema_fixture),true,repeat(''0'',64))','42501');
select pg_temp.schema_error('select * from private.calculator_schema_approvals','42501');
do $$begin
 assert (select jsonb_array_length(columns)=3 from public.my_product_master_sources(array['arseo-master-calculator'])),
  'denied employee sees catalogue and sales, not either margin';
end $$;
reset role;
do $$begin
 assert (select count(*) from private.calculator_schema_approvals)=(select approvals+1 from calc_schema_before),'exactly one historical approval';
 assert (select previous_schema->>'header_fingerprint'='schema-review-old' and approved_schema->>'header_fingerprint'='schema-review-new'
  and approved_by='e8610000-0000-4000-8000-000000000001' from private.calculator_schema_approvals order by approved_at desc limit 1),'audit preserves both schemas and actor';
 assert (select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') from public.products p)=(select products from calc_schema_before),'approval and preview leave products unchanged';
 assert (select coalesce(jsonb_agg(to_jsonb(p) order by p.product_id,p.source_key),'[]') from public.product_master_data p)=(select snapshots from calc_schema_before),'existing commercial values unchanged';
 assert not has_table_privilege('authenticated','private.calculator_schema_approvals','insert');
 assert not has_function_privilege('anon','public.review_calculator_schema(jsonb,boolean,text)','execute');
 assert not has_function_privilege('service_role','public.review_calculator_schema(jsonb,boolean,text)','execute');
end $$;
-- Personal products.view denial is checked independently of the administrator role.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e8610000-0000-4000-8000-000000000001',id,'deny','Independent permission test','e8610000-0000-4000-8000-000000000001' from public.permissions where code='products.view';
set role authenticated;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000001',true);
select pg_temp.schema_error('select public.review_calculator_schema((select new_source from calc_schema_fixture),true,repeat(''0'',64))','42501');
reset role;
delete from public.user_permission_overrides where user_id='e8610000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code='products.view');
-- Personal products.create denial is checked independently of the administrator role.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e8610000-0000-4000-8000-000000000001',id,'deny','Independent permission test','e8610000-0000-4000-8000-000000000001' from public.permissions where code='products.create';
set role authenticated;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000001',true);
select pg_temp.schema_error('select public.review_calculator_schema((select new_source from calc_schema_fixture),true,repeat(''0'',64))','42501');
reset role;
delete from public.user_permission_overrides where user_id='e8610000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code='products.create');
-- Personal products.update denial is checked independently of the administrator role.
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e8610000-0000-4000-8000-000000000001',id,'deny','Independent permission test','e8610000-0000-4000-8000-000000000001' from public.permissions where code='products.update';
set role authenticated;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000001',true);
select pg_temp.schema_error('select public.review_calculator_schema((select new_source from calc_schema_fixture),true,repeat(''0'',64))','42501');
reset role;
delete from public.user_permission_overrides where user_id='e8610000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code='products.update');
-- Explicit apply is a separate step. It imports the new fields with their
-- original visibility; the employee denied purchase access cannot read margin.
set role authenticated;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000001',true);
select public.import_calculator_master_data(pg_temp.schema_package((select new_source from calc_schema_fixture)),false);
do $$begin
 assert (select confidential_data->>'source.установленные_цены.новая_маржа'='42'
  from public.my_product_master_confidential_data(array[(select id from public.products where internal_sku='SCHEMA-REVIEW-1')]));
end $$;
select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000002',true);
select pg_temp.schema_error('select * from public.my_product_master_confidential_data(null)','42501');
do $$begin
 assert (select sales_data->>'source.установленные_цены.новая_цена'='100' and not sales_data?'source.установленные_цены.новая_маржа'
 from public.product_master_data where product_id=(select id from public.products where internal_sku='SCHEMA-REVIEW-1'));
end $$;
reset role;
rollback;
