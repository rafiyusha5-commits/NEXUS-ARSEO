-- Price backfill, future synchronization, manual edits and permission boundaries.
\set ON_ERROR_STOP 1
begin;
insert into public.currencies(code,name) values('USD','{"en":"US dollar"}') on conflict(code) do nothing;
delete from public.product_master_data where source_key='arseo-master-calculator' and product_id<>(select id from public.products where internal_sku='CALC-1');
set role authenticated;
select tests.calc_act_as('d4300000-0000-4000-8000-000000000001');
select public.import_calculator_master_data((select payload from tests.calculator_packages where name='base'),false);
do $$declare r jsonb;v_price numeric;v_id uuid;v_currency uuid;v_payload jsonb;begin
 select id into v_id from public.products where internal_sku='CALC-1';
 assert v_id is not null,'calculator baseline exists';
 r:=public.sync_calculator_purchase_prices('EUR',true,null);
 assert (r->'summary'->>'update')::integer=1,'preview fills only missing price';
 assert not r->>'snapshot' is null,'preview has snapshot';
 select base_purchase_price into v_price from public.my_product_purchase_prices(array[v_id]);assert v_price is null,'dry run writes no price';
 perform tests.calc_expect_error($q$select public.sync_calculator_purchase_prices('EUR',false,null)$q$,'Повторите предпросмотр');
 r:=public.sync_calculator_purchase_prices('EUR',false,r->>'snapshot');
 select base_purchase_price,currency_id into v_price,v_currency from public.my_product_purchase_prices(array[v_id]);
 assert v_price=1.25,'saved source price fills product';assert (select code='EUR' from public.currencies where id=v_currency),'currency accompanies price';
 r:=public.sync_calculator_purchase_prices('EUR',true,null);assert (r->'summary'->>'unchanged')::integer=1,'reapply is idempotent';
 v_payload:=jsonb_set((select payload from tests.calculator_packages where name='base'),'{source,rows,0,confidential_data,source.информация_о_закупе.цена}','1.5');
 r:=public.import_calculator_master_data(v_payload,true);
 assert (r->'purchase_prices'->'summary'->>'update')::integer=1,'future preview includes price';
 select base_purchase_price into v_price from public.my_product_purchase_prices(array[v_id]);assert v_price=1.25,'future preview does not change price';
 r:=public.import_calculator_master_data(v_payload,false);
 select base_purchase_price into v_price from public.my_product_purchase_prices(array[v_id]);assert v_price=1.5,'future import updates tracked price';
 perform tests.calc_expect_error($q$select public.sync_calculator_purchase_prices('EUR',false,'outdated')$q$,'Повторите предпросмотр');
end$$;
do $$declare r jsonb;v_payload jsonb;v_id uuid;v_currency uuid;v_price numeric;begin
 select id into v_id from public.products where internal_sku='CALC-1';
 v_payload:=(select payload from tests.calculator_packages where name='base');
 v_payload:=jsonb_set(v_payload,'{source,columns}',(v_payload#>'{source,columns}')||jsonb_build_array(jsonb_build_object('key','purchase.currency','position',100,'field_ru','Валюта закупа','field_en',null,'block','Информация о закупе','visibility','catalog','source_number',null,'source_code',null)));
 v_payload:=jsonb_set(v_payload,'{source,rows,0,catalog_data,purchase.currency}','"USD"');
 r:=public.import_calculator_master_data(v_payload,false);
 select base_purchase_price,currency_id into v_price,v_currency from public.my_product_purchase_prices(array[v_id]);
 assert v_price=1.25 and (select code='USD' from public.currencies where id=v_currency),'source currency wins over fallback';
 v_payload:=jsonb_set(v_payload,'{source,rows,0,catalog_data,purchase.currency}','"ZZZ"');
 r:=public.import_calculator_master_data(v_payload,false);
 assert r->'purchase_prices'->'items'->0->>'action'='invalid_currency','unrecognized explicit currency is not replaced by EUR';
 select currency_id into v_currency from public.my_product_purchase_prices(array[v_id]);assert (select code='USD' from public.currencies where id=v_currency),'invalid currency does not overwrite the product';
end$$;
reset role;
update public.products set base_purchase_price=7 where internal_sku='CALC-1';
set role authenticated;
select tests.calc_act_as('d4300000-0000-4000-8000-000000000001');
select public.import_calculator_master_data((select payload from tests.calculator_packages where name='base'),false);
do $$declare r jsonb;v_id uuid;v_price numeric;begin
 select id into v_id from public.products where internal_sku='CALC-1';
 r:=public.import_calculator_master_data((select payload from tests.calculator_packages where name='base'),false);
 assert (r->'purchase_prices'->'items'->0->>'action')='manual_conflict','manual edit is reported';
 select base_purchase_price into v_price from public.my_product_purchase_prices(array[v_id]);assert v_price=7,'manual price is retained';
 r:=public.import_calculator_master_data(jsonb_set((select payload from tests.calculator_packages where name='base'),'{source,rows,0,confidential_data}','{}'),false);
 assert r->'purchase_prices'->'items'->0->>'action'='missing_price','missing values are reported';
 select base_purchase_price into v_price from public.my_product_purchase_prices(array[v_id]);assert v_price=7,'missing price is not zero';
end$$;
select tests.calc_act_as('d4300000-0000-4000-8000-000000000002');
select tests.calc_expect_error($q$select public.sync_calculator_purchase_prices('EUR',true,null)$q$,'Нет прав');
select tests.calc_expect_error($q$select public.sync_calculator_purchase_prices('EUR',false,'forged')$q$,'Нет прав');
reset role;
do $$begin
 assert (select relrowsecurity from pg_class where oid='private.calculator_purchase_settings'::regclass),'settings have RLS';
 assert (select relrowsecurity from pg_class where oid='private.calculator_purchase_links'::regclass),'price tracking has RLS';
 assert not has_table_privilege('authenticated','private.calculator_purchase_settings','select,insert,update'),'mapping cannot be bypassed directly';
 assert not has_table_privilege('authenticated','private.calculator_purchase_links','select,insert,update'),'protected price tracking is private';
 assert not has_function_privilege('anon','public.sync_calculator_purchase_prices(text,boolean,text)','execute'),'anonymous calls denied';
 assert not has_function_privilege('service_role','public.sync_calculator_purchase_prices(text,boolean,text)','execute'),'service key is not a user import session';
 assert not has_function_privilege('authenticated','private.calculator_purchase_projection(jsonb,uuid,text,boolean)','execute'),'private writer closed';
end$$;
rollback;
