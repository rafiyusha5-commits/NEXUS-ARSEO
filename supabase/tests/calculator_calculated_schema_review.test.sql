-- 202611190200 + 202611080100: a new column of the block «РАСЧЕТНЫЕ ЦЕНЫ» is approved on the structure review only with
-- the access level "calculated" (a margin there stays confidential), and its values are imported into calculated_data,
-- readable with pricing.calculated.view only. Synthetic data only; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('e8620000-0000-4000-8000-000000000001','calc-review@test.local','{"full_name":"Calculated review"}'),
 ('e8620000-0000-4000-8000-000000000002','calc-review-denied@test.local','{"full_name":"Calculated denied"}');
insert into public.user_roles(user_id,role_id)
 select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in ('e8620000-0000-4000-8000-000000000001','e8620000-0000-4000-8000-000000000002') and r.code='administrator';
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e8620000-0000-4000-8000-000000000002',id,'deny','No calculated prices','e8620000-0000-4000-8000-000000000001'
 from public.permissions where code='pricing.calculated.view';

create temporary table calc_review_fixture as select $j${
 "key":"arseo-master-calculator","title":"Synthetic calculator","sheet_name":"расчеты","header_rows":5,
 "header_fingerprint":"calculated-review-old","rows":[],"columns":[
 {"key":"product.category","field_ru":"Категория товаров","block":null,"visibility":"catalog","position":1},
 {"key":"source.расчетные_цены.ррц_тенге","field_ru":"РРЦ, тенге","block":"РАСЧЕТНЫЕ ЦЕНЫ","visibility":"calculated","position":2},
 {"key":"source.расчетные_цены.маржа_в_kz","field_ru":"Маржа в KZ","block":"РАСЧЕТНЫЕ ЦЕНЫ","visibility":"confidential","position":3},
 {"key":"source.установленные_цены.ррц_тенге","field_ru":"РРЦ, тенге","block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"sales","position":4}
 ]}$j$::jsonb old_source,
 $j${"key":"source.расчетные_цены.новая_цена","field_ru":"Новая расчётная цена","block":"РАСЧЕТНЫЕ ЦЕНЫ","visibility":"calculated","position":5}$j$::jsonb price,
 $j${"key":"source.расчетные_цены.новая_маржа","field_ru":"Новая маржа","block":"РАСЧЕТНЫЕ ЦЕНЫ","visibility":"confidential","position":6}$j$::jsonb margin;
delete from public.product_master_data where source_key='arseo-master-calculator';
insert into public.product_master_sources(source_key,title,sheet_name,header_fingerprint,columns)
 select old_source->>'key','Synthetic calculator','расчеты',old_source->>'header_fingerprint',old_source->'columns' from calc_review_fixture
 on conflict(source_key) do update set header_fingerprint=excluded.header_fingerprint,columns=excluded.columns;
grant select on calc_review_fixture to authenticated;

create function pg_temp.review_error(q text, code text) returns void language plpgsql as $$
begin execute q;raise exception 'Expected failure' using errcode='P0099';
exception when others then if sqlstate<>code then raise exception 'Expected %, got %: %',code,sqlstate,sqlerrm;end if;end $$;
-- The old source plus the given columns, with a new fingerprint.
create function pg_temp.with_columns(p_added jsonb) returns jsonb language sql as $$
 select jsonb_set(jsonb_set(old_source,'{header_fingerprint}','"calculated-review-new"'),'{columns}',(old_source->'columns')||p_added)
   from calc_review_fixture
$$;
create function pg_temp.package(s jsonb) returns jsonb language sql as $$
 select jsonb_build_object('format','nexus-calculator-import','version',1,'reference',$j${
  "format":"nexus-reference-import","version":1,"counterparties":[
   {"row":6,"ref":"Calculated Factory","legal_name":"Calculated Factory","roles":["manufacturer","supplier"],"country":"FI"}],
  "products":[{"row":6,"internal_sku":"CALC-REVIEW-1","name":{"ru":"Проверка расчётных цен"},"manufacturer":"Calculated Factory","identifiers":[],"packaging":[]}]}
 $j$::jsonb,'source',s||jsonb_build_object('rows',$j$[{
  "row":6,"internal_sku":"CALC-REVIEW-1","category":"Тест","catalog_data":{},
  "sales_data":{"source.установленные_цены.ррц_тенге":50},
  "confidential_data":{"source.расчетные_цены.новая_маржа":0.25},
  "calculated_data":{"source.расчетные_цены.новая_цена":100}}]$j$::jsonb));
$$;

set role authenticated;
select set_config('request.jwt.claim.sub','e8620000-0000-4000-8000-000000000001',true);
do $$declare s jsonb;r jsonb;f record;begin
 -- 1. A calculated price may not arrive as a sales field, and a margin of the block may not arrive as calculated:
 --    both would show the value to people who should not see it. They are blocked, also on confirmation.
 for f in select jsonb_set(price,'{visibility}','"sales"') c from calc_review_fixture
  union all select jsonb_set(margin,'{visibility}','"calculated"') from calc_review_fixture
  union all select jsonb_set(margin,'{visibility}','"sales"') from calc_review_fixture
 loop
  s:=pg_temp.with_columns(jsonb_build_array(f.c));
  r:=public.review_calculator_schema(s);
  assert r->>'status'='blocked',format('blocked: %s as %s',f.c->>'key',f.c->>'visibility');
  perform pg_temp.review_error(format('select public.review_calculator_schema(%L,true,%L)',s,r->>'expected_schema'),'NX409');
 end loop;

 -- 2. A new calculated price with level "calculated" and a new margin with level "confidential" are approved.
 select pg_temp.with_columns(jsonb_build_array(price,margin)) into s from calc_review_fixture;
 r:=public.review_calculator_schema(s);
 assert r->>'status'='approval_required' and jsonb_array_length(r->'added')=2,'calculated price and margin need approval';
 r:=public.review_calculator_schema(s,true,r->>'expected_schema');
 assert r->>'status'='approved';

 -- 3. The import stores each value in the bucket of its level.
 perform public.import_calculator_master_data(pg_temp.package(s),false);
 assert (select calculated_data->>'source.расчетные_цены.новая_цена'
           from public.my_product_master_calculated_data(array[(select id from public.products where internal_sku='CALC-REVIEW-1')]))='100',
   'the new calculated price is readable with pricing.calculated.view';
 assert (select sales_data->>'source.установленные_цены.ррц_тенге'='50' and not sales_data ? 'source.расчетные_цены.новая_цена'
           and not sales_data ? 'source.расчетные_цены.новая_маржа'
           from public.product_master_data where product_id=(select id from public.products where internal_sku='CALC-REVIEW-1')),
   'neither the calculated price nor the margin lands in the sales data';
 assert (select confidential_data->>'source.расчетные_цены.новая_маржа'
           from public.my_product_master_confidential_data(array[(select id from public.products where internal_sku='CALC-REVIEW-1')]))='0.25';
end $$;

-- 4. A personal deny of pricing.calculated.view hides the approved column's values.
select set_config('request.jwt.claim.sub','e8620000-0000-4000-8000-000000000002',true);
select pg_temp.review_error('select * from public.my_product_master_calculated_data(null)','42501');
reset role;

do $$begin
 assert (select c->>'visibility' from public.product_master_sources ps, jsonb_array_elements(ps.columns) c
          where ps.source_key='arseo-master-calculator' and c->>'key'='source.расчетные_цены.новая_цена')='calculated',
   'the approved column keeps the calculated level';
 assert (select c->>'visibility' from public.product_master_sources ps, jsonb_array_elements(ps.columns) c
          where ps.source_key='arseo-master-calculator' and c->>'key'='source.расчетные_цены.новая_маржа')='confidential',
   'the approved margin stays confidential';
 assert (select calculated_data from public.product_master_data
          where product_id=(select id from public.products where internal_sku='CALC-REVIEW-1'))
        ='{"source.расчетные_цены.новая_цена":100}'::jsonb,'only the calculated price is in calculated_data';
end $$;
\echo calculator_calculated_schema_review: all checks passed
rollback;
