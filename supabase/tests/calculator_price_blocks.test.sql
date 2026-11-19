-- 202611190200: calculated prices of the master calculator get their own block, keys and access level; the stored
-- description, the loaded product data and the price types are renamed once. Synthetic data only; rolled back.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('ac200000-0000-4000-8000-000000000001','calc-blocks@example.invalid','{"full_name":"Calculator blocks"}'),
 ('ac200000-0000-4000-8000-000000000002','calc-blocks-2@example.invalid','{"full_name":"Calculator blocks two"}');
insert into public.user_roles(user_id,role_id) select u,id from public.app_roles,
 (values('ac200000-0000-4000-8000-000000000001'::uuid),('ac200000-0000-4000-8000-000000000002'::uuid)) v(u) where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('ac210000-0000-4000-8000-000000000001',array['manufacturer','supplier'],'Calc blocks supplier','FI','AC2-SUP');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('ac220000-0000-4000-8000-000000000001','AC2-A','{"ru":"Товар калькулятора"}','ac210000-0000-4000-8000-000000000001','active');

-- 1. The right is given to every role that sees products.
do $$begin
 assert exists(select 1 from public.permissions where code='pricing.calculated.view' and module='pricing');
 assert not exists(select 1 from public.role_permissions rp join public.permissions p on p.id=rp.permission_id and p.code='products.view' and rp.granted
   where not exists(select 1 from public.role_permissions x join public.permissions q on q.id=x.permission_id and q.code='pricing.calculated.view'
                     where x.role_id=rp.role_id and x.granted)),'every role with products.view sees calculated prices';
end $$;

-- 2. The description as the parser stored it before 2026-11-19: calculated columns in the established block.
delete from public.product_master_data where source_key='arseo-master-calculator';
delete from public.product_master_sources where source_key='arseo-master-calculator';
update public.price_types set source_column_key=source_column_key||'.2'
 where code in ('kz_prepayment','kz_realization','kz_rrp','export_ru') and source_column_key !~ '\.2$';
create temporary table cols(position integer,block text,field text,key text,visibility text);
insert into cols values
 (1,null,'Артикул ARSEO','product.internal_sku','catalog'),
 (62,'РАСЧЕТНЫЕ ЦЕНЫ','Маржа в KZ','source.расчетные_цены.маржа_в_kz','confidential'),
 (63,'УСТАНОВЛЕННЫЕ ЦЕНЫ','ЦП в КЗ сеть с НДС, тенге','source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге','sales'),
 (64,'УСТАНОВЛЕННЫЕ ЦЕНЫ','ЦП в КЗ сеть с НДС, тенге (РЕАЛИЗАЦИЯ)','source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге_реализация','sales'),
 (65,'УСТАНОВЛЕННЫЕ ЦЕНЫ','РРЦ, тенге','source.установленные_цены.ррц_тенге','sales'),
 (66,'УСТАНОВЛЕННЫЕ ЦЕНЫ','Маржа в RU','source.установленные_цены.маржа_в_ru','confidential'),
 (68,'УСТАНОВЛЕННЫЕ ЦЕНЫ','РОССИЯ DAP РЦ МСК, БЕЗ НДС KZT','source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt','sales'),
 (71,'УСТАНОВЛЕННЫЕ ЦЕНЫ',E'EXW Almaty/Aktobe, KAZAKHSTAN\n БЕЗ НДС\nEUR','source.установленные_цены.exw_almaty_aktobe_kazakhstan_без_ндс_eur','sales'),
 (72,'УСТАНОВЛЕННЫЕ ЦЕНЫ','ЦП в КЗ сеть с НДС, тенге','source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2','sales'),
 (73,'УСТАНОВЛЕННЫЕ ЦЕНЫ','ЦП в КЗ сеть с НДС, тенге (РЕАЛИЗАЦИЯ)','source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге_реализация.2','sales'),
 (74,'УСТАНОВЛЕННЫЕ ЦЕНЫ','РРЦ, тенге','source.установленные_цены.ррц_тенге.2','sales'),
 (75,'УСТАНОВЛЕННЫЕ ЦЕНЫ','Маржа в RU факт','source.установленные_цены.маржа_в_ru_факт','confidential'),
 (76,'УСТАНОВЛЕННЫЕ ЦЕНЫ','РОССИЯ DAP РЦ МСК, БЕЗ НДС KZT','source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt.2','sales'),
 (77,'УСТАНОВЛЕННЫЕ ЦЕНЫ','Маржа в RU факт','source.установленные_цены.маржа_в_ru_факт.2','confidential'),
 (79,'УСТАНОВЛЕННЫЕ ЦЕНЫ',E'КЫРГЫЗСТАН\nEXW ALA\n БЕЗ НДС\nEUR','source.установленные_цены.кыргызстан_exw_ala_без_ндс_eur','sales');
insert into public.product_master_sources(source_key,title,sheet_name,header_fingerprint,columns)
select 'arseo-master-calculator','Synthetic calculator','расчеты','old',
       jsonb_agg(jsonb_build_object('key',key,'position',position,'block',block,'field_ru',field,'visibility',visibility) order by position)
  from cols;
insert into public.product_master_data(product_id,source_key,source_row,catalog_data,sales_data,confidential_data) values
 ('ac220000-0000-4000-8000-000000000001','arseo-master-calculator',6,'{"product.internal_sku":"AC2-A"}',
  jsonb_build_object('source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге',111,'source.установленные_цены.ррц_тенге',112,
    'source.установленные_цены.exw_almaty_aktobe_kazakhstan_без_ндс_eur',113,
    'source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге.2',211,'source.установленные_цены.ррц_тенге.2',212,
    'source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt.2',213),
  jsonb_build_object('source.расчетные_цены.маржа_в_kz',0.3,'source.установленные_цены.маржа_в_ru',0.2,
    'source.установленные_цены.маржа_в_ru_факт',0.1,'source.установленные_цены.маржа_в_ru_факт.2',0.15));

-- 3. One renaming; a second run changes nothing.
do $$
declare s public.product_master_sources; d public.product_master_data; c jsonb;
begin
 assert private.fix_calculator_price_blocks()=1,'the source is renamed once';
 select * into s from public.product_master_sources where source_key='arseo-master-calculator';
 select * into d from public.product_master_data where source_key='arseo-master-calculator';
 select value into c from jsonb_array_elements(s.columns) where (value->>'position')::int=63;
 assert c->>'block'='РАСЧЕТНЫЕ ЦЕНЫ' and c->>'key'='source.расчетные_цены.цп_в_кз_сеть_с_ндс_тенге' and c->>'visibility'='calculated';
 select value into c from jsonb_array_elements(s.columns) where (value->>'position')::int=66;
 assert c->>'block'='РАСЧЕТНЫЕ ЦЕНЫ' and c->>'key'='source.расчетные_цены.маржа_в_ru' and c->>'visibility'='confidential';
 select value into c from jsonb_array_elements(s.columns) where (value->>'position')::int=72;
 assert c->>'block'='УСТАНОВЛЕННЫЕ ЦЕНЫ' and c->>'key'='source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге' and c->>'visibility'='sales';
 select value into c from jsonb_array_elements(s.columns) where (value->>'position')::int=77;
 assert c->>'key'='source.установленные_цены.маржа_в_ru_факт.2','a field repeated inside one block keeps .2';
 select value into c from jsonb_array_elements(s.columns) where (value->>'position')::int=1;
 assert c->>'key'='product.internal_sku' and c->>'visibility'='catalog','columns outside the price blocks are untouched';
 assert s.header_fingerprint=private.calculator_header_fingerprint(s.columns) and s.header_fingerprint like '%source.расчетные_цены.цп_в_кз_сеть_с_ндс_тенге|РАСЧЕТНЫЕ ЦЕНЫ|ЦП в КЗ сеть с НДС, тенге|calculated%',
   'the fingerprint is the one the corrected parser computes';
 assert d.calculated_data=jsonb_build_object('source.расчетные_цены.цп_в_кз_сеть_с_ндс_тенге',111,'source.расчетные_цены.ррц_тенге',112,
   'source.расчетные_цены.exw_almaty_aktobe_kazakhstan_без_ндс_eur',113),'calculated prices moved out of the sales data';
 assert d.sales_data=jsonb_build_object('source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге',211,'source.установленные_цены.ррц_тенге',212,
   'source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt',213),'established prices lost the .2 suffix';
 assert d.confidential_data=jsonb_build_object('source.расчетные_цены.маржа_в_kz',0.3,'source.расчетные_цены.маржа_в_ru',0.2,
   'source.установленные_цены.маржа_в_ru_факт',0.1,'source.установленные_цены.маржа_в_ru_факт.2',0.15),'margins renamed, still closed';
 assert d.catalog_data='{"product.internal_sku":"AC2-A"}'::jsonb;
 assert (select source_column_key from public.price_types where code='kz_prepayment')='source.установленные_цены.цп_в_кз_сеть_с_ндс_тенге';
 assert (select source_column_key from public.price_types where code='kz_rrp')='source.установленные_цены.ррц_тенге';
 assert (select source_column_key from public.price_types where code='export_ru')='source.установленные_цены.россия_dap_рц_мск_без_ндс_kzt';
 assert (select source_column_key from public.price_types where code='lenta')='source.установленные_цены.цп_лента','keys without .2 unchanged';
 assert private.fix_calculator_price_blocks()=0,'a second run changes nothing';
 assert (select columns from public.product_master_sources where source_key='arseo-master-calculator')=s.columns;
 assert (select calculated_data from public.product_master_data where source_key='arseo-master-calculator')=d.calculated_data;
end $$;

-- 4. Reading: the right is needed; a personal deny takes it; the column is not readable directly.
create function pg_temp.fails(p_sql text,p_pattern text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when others then
  if sqlerrm !~* p_pattern then raise exception 'expected error matching %, got: %',p_pattern,sqlerrm;end if;return;
 end;
 raise exception 'expected an error matching %, but the statement succeeded',p_pattern;
end $$;
grant execute on all functions in schema pg_temp to authenticated;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'ac200000-0000-4000-8000-000000000002',id,'deny','No calculated prices','ac200000-0000-4000-8000-000000000001'
 from public.permissions where code='pricing.calculated.view';
select set_config('request.jwt.claim.sub','ac200000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$begin
 assert (select calculated_data->>'source.расчетные_цены.ррц_тенге' from public.my_product_master_calculated_data(array['ac220000-0000-4000-8000-000000000001'::uuid]))='112';
 assert (select sales_data ? 'source.установленные_цены.ррц_тенге' and not sales_data ? 'source.расчетные_цены.ррц_тенге'
           from public.product_master_data where product_id='ac220000-0000-4000-8000-000000000001');
end $$;
select pg_temp.fails($q$select calculated_data from public.product_master_data$q$,'permission denied');
reset role;
select set_config('request.jwt.claim.sub','ac200000-0000-4000-8000-000000000002',true);
set local role authenticated;
select pg_temp.fails($q$select * from public.my_product_master_calculated_data(null)$q$,'Нет доступа к расчётным ценам');
reset role;
do $$begin
 assert not has_function_privilege('anon','public.my_product_master_calculated_data(uuid[])','execute');
end $$;

-- 5. The import accepts the calculated bucket only for columns of that access level.
do $$
declare v_payload jsonb;
begin
 v_payload:=jsonb_build_object('format','nexus-calculator-import','version','1','reference','{}'::jsonb,
  'source',jsonb_build_object('key','arseo-master-calculator','sheet_name','Расчеты','header_rows',5,
   'columns',(select columns from public.product_master_sources where source_key='arseo-master-calculator'),
   'rows',jsonb_build_array(jsonb_build_object('row',6,'internal_sku','AC2-A','catalog_data','{}'::jsonb,'sales_data','{}'::jsonb,
     'confidential_data','{}'::jsonb,'calculated_data',jsonb_build_object('source.расчетные_цены.ррц_тенге',1)))));
 perform private.validate_calculator_import(v_payload);
 v_payload:=jsonb_set(v_payload,'{source,rows,0,calculated_data}',jsonb_build_object('source.установленные_цены.ррц_тенге',1));
 begin
  perform private.validate_calculator_import(v_payload);
  raise exception 'an established price in the calculated bucket was accepted';
 exception when others then
  if sqlerrm !~ 'Расчётная цена не соответствует схеме' then raise; end if;
 end;
 -- An older client without the bucket still validates.
 v_payload:=v_payload #- '{source,rows,0,calculated_data}';
 perform private.validate_calculator_import(v_payload);
 assert position('calculated_data' in pg_get_functiondef('public.import_calculator_master_data(jsonb,boolean)'::regprocedure))>0,
   'the import stores the calculated bucket';
 assert position('''calculated''' in pg_get_functiondef('public.review_calculator_schema(jsonb,boolean,text)'::regprocedure))>0,
   'the structure review knows the calculated access level';
end $$;
\echo calculator_price_blocks: all checks passed
rollback;
