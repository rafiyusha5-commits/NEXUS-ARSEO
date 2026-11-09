-- Synthetic catalogue only. Covers real preview/apply RPC, barcode reconciliation,
-- manual changes, source history, permissions and repeat imports.
\set ON_ERROR_STOP 1
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('e8820000-0000-4000-8000-000000000001','protected-fields@test.local','{"full_name":"Protected fields"}');
insert into public.user_roles(user_id,role_id) select 'e8820000-0000-4000-8000-000000000001',id from public.app_roles where code='administrator';
create temporary table protected_fixture(payload jsonb);
insert into protected_fixture values($json${
 "format":"nexus-calculator-import","version":1,
 "reference":{"format":"nexus-reference-import","version":1,"counterparties":[
  {"row":6,"ref":"Protected Factory","legal_name":"Protected Factory","roles":["manufacturer","supplier"],"country":"FI"}],
  "products":[
   {"row":6,"internal_sku":"PROTECT-1","name":{"ru":"Защищённый"},"manufacturer":"Protected Factory","shelf_life_days":547,"hs_code":"18063290","brand":"Updated brand","identifiers":[],"packaging":[]},
   {"row":7,"internal_sku":"EMPTY-1","name":{"ru":"Пустые поля"},"manufacturer":"Protected Factory","shelf_life_days":600,"hs_code":"1806310000","identifiers":[],"packaging":[]},
   {"row":8,"internal_sku":"NEW-1","name":{"ru":"Новый"},"manufacturer":"Protected Factory","shelf_life_days":720,"hs_code":"1806901900","identifiers":[],"packaging":[]},
   {"row":9,"internal_sku":"CANON-1","name":{"ru":"По штрихкоду"},"manufacturer":"Protected Factory","shelf_life_days":547,"hs_code":"18063290","identifiers":[{"type":"unit_barcode","value":"4006381333931","packaging_uom":"piece","is_primary":true}],"packaging":[]}
  ]},
 "source":{"key":"arseo-master-calculator","title":"Synthetic protected fields","sheet_name":"расчеты","header_rows":5,"header_fingerprint":"protected-fields-v1","columns":[
  {"key":"product.shelf_life_days","position":1,"field_ru":"Срок годности, дни","visibility":"catalog"},
  {"key":"product.hs_code","position":2,"field_ru":"ТНВЭД","visibility":"catalog"}],"rows":[
   {"row":6,"internal_sku":"PROTECT-1","catalog_data":{"product.shelf_life_days":547,"product.hs_code":"18063290"},"sales_data":{},"confidential_data":{}},
   {"row":7,"internal_sku":"EMPTY-1","catalog_data":{"product.shelf_life_days":600,"product.hs_code":"1806310000"},"sales_data":{},"confidential_data":{}},
   {"row":8,"internal_sku":"NEW-1","catalog_data":{"product.shelf_life_days":720,"product.hs_code":"1806901900"},"sales_data":{},"confidential_data":{}},
   {"row":9,"internal_sku":"CANON-1","catalog_data":{"product.shelf_life_days":547,"product.hs_code":"18063290"},"sales_data":{},"confidential_data":{}}
 ]}
}$json$::jsonb);
insert into public.product_master_sources(source_key,title,sheet_name,header_fingerprint,columns)
 select 'arseo-master-calculator','Synthetic protected fields','расчеты','protected-fields-v1',payload#>'{source,columns}' from protected_fixture
 on conflict(source_key) do update set header_fingerprint=excluded.header_fingerprint,columns=excluded.columns;
grant select on protected_fixture to authenticated;
create function pg_temp.protection_error(q text) returns void language plpgsql as $$begin
 execute q;raise exception 'Expected rejection' using errcode='P0099';
 exception when sqlstate 'P0099' then raise;when others then null;end$$;
set role authenticated;
select set_config('request.jwt.claim.sub','e8820000-0000-4000-8000-000000000001',true);
-- Seed through the ordinary importer; explicit catalogue editing stays available.
do $$declare p jsonb;begin
 select payload->'reference' into p from protected_fixture;
 p:=jsonb_set(p,'{products}',(p->'products')-2);
 p:=jsonb_set(p,'{products,0,shelf_life_days}','540');
 p:=jsonb_set(p,'{products,0,hs_code}','"1806329000"');
 p:=jsonb_set(p,'{products,1}',(p#>'{products,1}')-'shelf_life_days'-'hs_code');
 p:=jsonb_set(p,'{products,2,internal_sku}','"LEGACY-PROTECT"');
 p:=jsonb_set(p,'{products,2,shelf_life_days}','540');
 p:=jsonb_set(p,'{products,2,hs_code}','"1806329000"');
 perform public.import_reference_data(p,false);
end$$;
reset role;
create temporary table protected_before as select
 (select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from public.products p) products,
 (select count(*) from public.audit_log) audits;
grant select on protected_before to authenticated;
set role authenticated;
do $$declare p jsonb;r jsonb;begin
 select payload into p from protected_fixture;
 r:=public.import_calculator_master_data(p,true);
 assert jsonb_array_length(r->'protected_fields')=4,'preview reports the two protected fields on both existing products';
 assert r#>>'{protected_fields,0,nexus_value}'='540' and r#>>'{protected_fields,0,source_value}'='547','source and catalogue not swapped';
 -- Full-row fingerprints include price columns which the browser role cannot SELECT.
 -- Only the observer uses the session owner; every import still runs as authenticated.
 reset role;
 assert (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from public.products x)=(select products from protected_before),'preview changes no product';
 assert (select count(*) from public.audit_log)=(select audits from protected_before),'preview changes no audit';
 set local role authenticated;
 r:=public.import_calculator_master_data(p,false);
 assert jsonb_array_length(r->'protected_fields')=4,'apply reports preserved values';
 assert (select shelf_life_days=540 and hs_code='1806329000' and brand='Updated brand' from public.products where internal_sku='PROTECT-1'),'preserve both fields, update unrelated brand';
 assert (select shelf_life_days=600 and hs_code='1806310000' from public.products where internal_sku='EMPTY-1'),'fill missing fields';
 assert (select shelf_life_days=720 and hs_code='1806901900' from public.products where internal_sku='NEW-1'),'new product fields imported';
 assert (select shelf_life_days=540 and hs_code='1806329000' from public.products where internal_sku='CANON-1'),'barcode reconciliation also preserves fields';
 assert not exists(select 1 from public.products where internal_sku='LEGACY-PROTECT'),'rename creates no second product';
 assert (select catalog_data->>'product.shelf_life_days'='547' and catalog_data->>'product.hs_code'='18063290' from public.product_master_data where product_id=(select id from public.products where internal_sku='PROTECT-1')),'source remains exact';
 assert exists(select 1 from public.audit_log where action='calculator_fields_preserved' and actor_user_id=auth.uid() and jsonb_array_length(metadata->'fields')=4),'preservation history identifies actor and fields';
 -- Manual correction after sync must take precedence again, including after repeats.
 update public.products set shelf_life_days=550,hs_code='1806329010' where internal_sku='PROTECT-1';
 perform public.import_calculator_master_data(p,false);
 perform public.import_calculator_master_data(p,false);
 assert (select shelf_life_days=550 and hs_code='1806329010' from public.products where internal_sku='PROTECT-1'),'new manual values survive repeat sync';
 assert (select count(*)=4 from public.products where internal_sku in('PROTECT-1','EMPTY-1','NEW-1','CANON-1')),'no duplicate products';
 perform pg_temp.protection_error(format('select public.import_calculator_master_data(%L,false)',jsonb_set(p,'{reference,products,0,shelf_life_days}','{}')));
 perform pg_temp.protection_error(format('select public.import_calculator_master_data(%L,false)',jsonb_set(p,'{reference,products,0,shelf_life_days}','0')));
 perform pg_temp.protection_error(format('select public.import_calculator_master_data(%L,false)',jsonb_set(p,'{reference,products,0,hs_code}','"not-a-code"')));
end$$;
reset role;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'e8820000-0000-4000-8000-000000000001',id,'deny','Protected-field visibility','e8820000-0000-4000-8000-000000000001' from public.permissions where code='products.view';
set role authenticated;
do $$begin
 perform public.import_calculator_master_data((select payload from protected_fixture),false);
 raise exception 'Expected permission denial' using errcode='P0099';
exception when insufficient_privilege then null;end$$;
reset role;
rollback;
