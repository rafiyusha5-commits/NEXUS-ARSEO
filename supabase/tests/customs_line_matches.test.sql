\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
update public.shipment_source_extractions set shipment_transport_id='eb310000-0000-4000-8000-000000000001' where id in ('eb601000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001');
update public.shipment_source_extractions set extracted_data='{"commodity_invoice":{"number":"SYN-1","currency":"EUR","items":[{"number":1,"sku":null,"description":"Synthetic hazelnut cream","quantity":999,"unit":"piece","amount":100,"hsCode":"1806310000","grossKg":null,"netKg":null,"customsValue":null,"warnings":[]}],"total":100,"warnings":[]}}' where id='eb601000-0000-4000-8000-000000000001';
update public.shipment_source_extractions set extracted_data='{"invoice_number":"SYN-1","supplier_lots":{"kind":"packing","items":[{"lot":"SYN-LOT","description":"Synthetic cream","quantity":999,"cartons":111,"pallets":1,"grossKg":10,"netKg":9}],"warnings":[]}}' where id='eb602000-0000-4000-8000-000000000001';
update public.shipment_source_extractions set source_kind='other',extracted_data='{"customs_record":{"kind":"declaration","fields":[{"label":"Номер","value":"TEST/000001"}],"invoiceNumbers":["SYN-1"],"currency":"EUR","expectedCount":1,"items":[{"number":1,"sku":null,"quantity":999,"unit":"piece","hsCode":"1806310000","description":"Synthetic cream","amount":100,"grossKg":10,"netKg":9,"customsValue":1000,"warnings":["Артикул или количество из приложения не определены однозначно."]}],"warnings":[]}}',confirmed_data='{"invoice_number":"KEEP"}' where id='eb603000-0000-4000-8000-000000000001';
create temporary table match_fixture as select
 (select jsonb_agg(private.customs_match_snapshot(e) order by array_position(array['eb603000-0000-4000-8000-000000000001'::uuid,'eb601000-0000-4000-8000-000000000001','eb602000-0000-4000-8000-000000000001'],e.id)) from public.shipment_source_extractions e where id in ('eb601000-0000-4000-8000-000000000001','eb602000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001')) snapshot,
 '[{"line":1,"invoice_line":1,"packing_line":1,"product_id":"eb200000-0000-4000-8000-000000000001","sku":"DQ-001"}]'::jsonb lines,
 (select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i) items,
 (select jsonb_agg(to_jsonb(e) order by id) from public.shipment_source_extractions e) sources,
 (select count(*) from public.inventory_movements) movements,
 (select count(*) from public.expenses) expenses;
grant select on match_fixture to authenticated;
create function pg_temp.save_match(s jsonb default null,l jsonb default null,expected uuid default null,reason text default 'Сверены название, партии и количество в трёх оригиналах') returns uuid language sql as $$
 select public.save_shipment_customs_match('eb603000-0000-4000-8000-000000000001','eb601000-0000-4000-8000-000000000001','eb602000-0000-4000-8000-000000000001',coalesce(s,(select snapshot from match_fixture)),coalesce(l,(select lines from match_fixture)),reason,expected)
$$;
create function pg_temp.review_match() returns uuid language sql as $$
 select public.review_mapped_shipment_customs('eb603000-0000-4000-8000-000000000001',(select id from public.shipment_customs_matches order by created_at desc,id desc limit 1),(select extracted_data->'customs_record' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'),'Оригинал проверен; отсутствие артикула не скрыто')
$$;
create function pg_temp.reject_match(q text,code text default null) returns void language plpgsql as $$
declare failed boolean:=false; before_sources jsonb; before_matches jsonb;
begin
 select jsonb_agg(to_jsonb(e) order by id) into before_sources from public.shipment_source_extractions e;
 select jsonb_agg(to_jsonb(m) order by id) into before_matches from public.shipment_customs_matches m;
 begin execute q; exception when others then failed:=true; if code is not null and sqlstate<>code then raise exception 'Wrong error: % %',sqlstate,sqlerrm; end if; end;
 assert failed,'Invalid operation accepted';
 assert before_sources is not distinct from (select jsonb_agg(to_jsonb(e) order by id) from public.shipment_source_extractions e),'Refusal changed source';
 assert before_matches is not distinct from (select jsonb_agg(to_jsonb(m) order by id) from public.shipment_customs_matches m),'Refusal changed history';
end $$;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
-- Original strict validator still refuses a declaration without SKU.
select pg_temp.reject_match($q$select private.validate_customs_evidence((select extracted_data->'customs_record' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'))$q$);
do $$declare permission text; begin
 foreach permission in array array['source_documents.review','shipments.view','documents.view','products.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'eb000000-0000-4000-8000-000000000001',id,'deny','Mapping test','eb000000-0000-4000-8000-000000000001' from public.permissions where code=permission;
  perform pg_temp.reject_match('select pg_temp.save_match()','42501');
  delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
set role authenticated;
select pg_temp.reject_match($q$select pg_temp.save_match('{}')$q$);
select pg_temp.reject_match($q$select pg_temp.save_match(null,'[]')$q$);
select pg_temp.reject_match($q$select pg_temp.save_match(null,(select lines||lines from match_fixture))$q$);
select pg_temp.reject_match($q$select pg_temp.save_match(null,jsonb_set((select lines from match_fixture),'{0,product_id}','"eb200000-0000-4000-8000-000000000002"'))$q$);
select pg_temp.reject_match($q$select pg_temp.save_match(null,jsonb_set((select lines from match_fixture),'{0,invoice_line}','1.1'))$q$);
select pg_temp.reject_match($q$select pg_temp.save_match(null,null,null,'short')$q$);
select pg_temp.save_match();
select pg_temp.save_match();
reset role;
do $$ begin
 assert (select count(*)=1 from public.shipment_customs_matches),'Retry duplicated mapping';
 assert (select sources from match_fixture)=(select jsonb_agg(to_jsonb(e) order by id) from public.shipment_source_extractions e),'Mapping changed confirmations or OCR';
end $$;
set role authenticated;
select pg_temp.review_match();
select pg_temp.review_match();
select pg_temp.reject_match($q$delete from public.shipment_customs_matches$q$,'42501');
select pg_temp.reject_match($q$select pg_temp.save_match(null,null,null,'Изменённое основание без актуальной версии')$q$,'40001');
reset role;
do $$declare e public.shipment_source_extractions%rowtype; mutation text; begin
 select * into e from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001';
 assert e.status='confirmed' and e.confirmed_data->>'invoice_number'='KEEP';
 assert e.confirmed_data->'customs_record'=e.extracted_data->'customs_record' and e.extracted_data#>'{customs_record,items,0,sku}'='null'::jsonb,'Original SKU was invented';
 foreach mutation in array array[
  $q$update public.document_versions set is_current=false where id='eb511000-0000-4000-8000-000000000001'$q$,
  $q$update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb502000-0000-4000-8000-000000000001'$q$,
  $q$update public.documents set status='rejected' where id='eb501000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{commodity_invoice,total}','101') where id='eb601000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set shipment_transport_id=null where id='eb602000-0000-4000-8000-000000000001'$q$,
  $q$update public.shipment_source_extractions set confirmed_data='{"invoice_number":"CORRECTED"}' where id='eb601000-0000-4000-8000-000000000001'$q$,
  $q$update public.products set internal_sku='CHANGED' where id='eb200000-0000-4000-8000-000000000001'$q$
 ] loop
  begin execute mutation; perform pg_temp.reject_match('select pg_temp.review_match()'); perform pg_temp.reject_match('select pg_temp.save_match()'); raise exception using errcode='ZX001'; exception when sqlstate 'ZX001' then null; end;
 end loop;
 assert (select items from match_fixture)=(select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i);
 assert (select movements from match_fixture)=(select count(*) from public.inventory_movements);
 assert (select expenses from match_fixture)=(select count(*) from public.expenses);
end $$;
-- Personal denies also hide the saved history; no new RPC can bypass them.
do $$declare permission text; begin
 foreach permission in array array['shipments.view','documents.view','products.view'] loop
  insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'eb000000-0000-4000-8000-000000000001',id,'deny','Read mapping test','eb000000-0000-4000-8000-000000000001' from public.permissions where code=permission;
  set local role authenticated;
  assert (select count(*)=0 from public.shipment_customs_matches),'History leaked through personal deny';
  perform pg_temp.reject_match('select pg_temp.review_match()','42501');
  reset role;
  delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code=permission);
 end loop;
end $$;
-- A new explicit revision preserves the former confirmation and its mapping token.
set role authenticated;
select pg_temp.save_match(null,null,(select id from public.shipment_customs_matches order by created_at desc,id desc limit 1),'Дополнительная проверка исходных этикеток и партии');
reset role;
do $$begin
 assert (select count(*)=2 from public.shipment_customs_matches);
 assert (select confirmed_data->>'customs_mapping_id' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001')=(select id::text from public.shipment_customs_matches order by created_at,id limit 1),'Old decision was silently overwritten';
end $$;
rollback;
\echo 'customs_line_matches: all checks passed'
