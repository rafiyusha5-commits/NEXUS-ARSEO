-- A calculator article may replace a legacy prefixed code only when its global
-- barcodes resolve to exactly one existing product. Dry-run must remain read-only.
\set ON_ERROR_STOP 1

insert into auth.users(id,email,raw_user_meta_data) values
 ('d4500000-0000-4000-8000-000000000001','calculator-match@test.local','{"full_name":"Calculator match"}');
insert into public.user_roles(user_id,role_id)
select 'd4500000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';

insert into public.counterparties(id,legal_name,short_name,roles,country,status) values
 ('d4500000-0000-4000-8000-000000000010','Calculator Match Factory','Match Factory',array['manufacturer','supplier'],'FI','active');
insert into public.products(id,internal_sku,name,manufacturer_id,status) values
 ('d4500000-0000-4000-8000-000000000020','FAZER-403747','{"ru":"Старое название"}',
  'd4500000-0000-4000-8000-000000000010','active'),
 ('d4500000-0000-4000-8000-000000000030','OTHER-OWNER','{"ru":"Другой товар"}',
  'd4500000-0000-4000-8000-000000000010','active');
insert into public.product_identifiers(product_id,identifier_type,value,counterparty_id,is_primary) values
 ('d4500000-0000-4000-8000-000000000020','unit_barcode','6411404035187',null,true),
 ('d4500000-0000-4000-8000-000000000020','box_barcode','6416453437470',null,false),
 ('d4500000-0000-4000-8000-000000000020','supplier_sku','403747','d4500000-0000-4000-8000-000000000010',true),
 ('d4500000-0000-4000-8000-000000000030','box_barcode','9999999999999',null,true);

create table if not exists tests.calculator_matching_packages(name text primary key,payload jsonb not null);
insert into tests.calculator_matching_packages(name,payload) values('legacy',$json${
 "format":"nexus-calculator-import","version":1,
 "reference":{"format":"nexus-reference-import","version":1,"counterparties":[],"products":[
  {"row":6,"internal_sku":"403747","name":{"ru":"Каноническое название"},"manufacturer":"Calculator Match Factory",
   "identifiers":[
    {"type":"unit_barcode","value":"6411404035187","is_primary":true},
    {"type":"box_barcode","value":"6416453437470","packaging_uom":"box"},
    {"type":"supplier_sku","value":"403747","counterparty":"Calculator Match Factory","is_primary":true}
   ],"packaging":[]}
 ]},
 "source":{"key":"arseo-master-calculator","title":"Master","sheet_name":"расчеты","header_rows":5,"header_fingerprint":"schema-v1","columns":[
  {"key":"product.category","position":1,"source_number":null,"source_code":null,"block":null,"field_en":null,"field_ru":"Категория","visibility":"catalog"}
 ],"rows":[
  {"row":6,"internal_sku":"403747","category":"Конфеты","catalog_data":{"product.category":"Конфеты"},"sales_data":{},"confidential_data":{}}
 ]}
}$json$),('ambiguous',$json${
 "format":"nexus-calculator-import","version":1,
 "reference":{"format":"nexus-reference-import","version":1,"counterparties":[],"products":[
  {"row":7,"internal_sku":"MIXED-1","name":{"ru":"Смешанные идентификаторы"},"manufacturer":"Calculator Match Factory",
   "identifiers":[
    {"type":"unit_barcode","value":"6411404035187"},
    {"type":"box_barcode","value":"9999999999999"}
   ],"packaging":[]}
 ]},
 "source":{"key":"arseo-master-calculator","title":"Master","sheet_name":"расчеты","header_rows":5,"header_fingerprint":"schema-v1","columns":[
  {"key":"product.category","position":1,"source_number":null,"source_code":null,"block":null,"field_en":null,"field_ru":"Категория","visibility":"catalog"}
 ],"rows":[
  {"row":7,"internal_sku":"MIXED-1","category":"Конфеты","catalog_data":{"product.category":"Конфеты"},"sales_data":{},"confidential_data":{}}
 ]}
}$json$);
grant select on tests.calculator_matching_packages to authenticated;

set role authenticated;
select tests.calc_act_as('d4500000-0000-4000-8000-000000000001');
do $$declare r jsonb;begin
 r:=public.import_calculator_master_data((select payload from tests.calculator_matching_packages where name='legacy'),true);
 assert (r#>>'{summary,conflict}')::integer=0,format('legacy barcode match must not conflict: %s',r);
 assert r#>>'{master_data,matched_by_barcode}'='1','preview reports one barcode match';
 assert exists(select 1 from public.products where id='d4500000-0000-4000-8000-000000000020' and internal_sku='FAZER-403747'),
   'dry-run keeps the legacy code';
 assert not exists(select 1 from public.products where internal_sku='403747'),'dry-run creates no canonical code';

 r:=public.import_calculator_master_data((select payload from tests.calculator_matching_packages where name='legacy'),false);
 assert r#>>'{master_data,matched_by_barcode}'='1','apply reports one renamed product';
 assert exists(select 1 from public.products where id='d4500000-0000-4000-8000-000000000020' and internal_sku='403747'),
   'the existing UUID receives the calculator article';
 assert not exists(select 1 from public.products where internal_sku='FAZER-403747'),'legacy code removed';
 assert (select count(*)=3 from public.product_identifiers where product_id='d4500000-0000-4000-8000-000000000020'),
   'identifiers stay on the same product';
 assert exists(select 1 from public.product_master_data
   where product_id='d4500000-0000-4000-8000-000000000020' and source_row=6),
   'calculator snapshot points to the same product';

 r:=public.import_calculator_master_data((select payload from tests.calculator_matching_packages where name='legacy'),false);
 assert (r#>>'{summary,conflict}')::integer=0,'second synchronization stays idempotent';

 r:=public.import_calculator_master_data((select payload from tests.calculator_matching_packages where name='ambiguous'),true);
 assert (r#>>'{summary,conflict}')::integer=2,format('two barcode owners must remain conflicts: %s',r);
 assert r#>>'{master_data,matched_by_barcode}'='0','ambiguous identifiers are never auto-matched';
 assert not exists(select 1 from public.products where internal_sku='MIXED-1'),'ambiguous dry-run writes nothing';
end$$;
reset role;
