\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
do $$
declare good jsonb:='{"kind":"declaration","fields":[{"label":"Номер","value":"TEST"}],"expectedCount":1,"items":[{"number":1,"sku":"DQ-001","quantity":999,"unit":"piece","hsCode":"1806310000","description":"Synthetic goods","amount":100,"grossKg":10,"netKg":9,"customsValue":1000,"warnings":[]}],"warnings":[]}';
 bad jsonb; patch jsonb; rejected boolean; snapshot jsonb; after_state jsonb;
begin
 perform private.validate_customs_evidence(good);
 perform private.validate_customs_evidence(jsonb_set(good,'{items,0,unit}','"ШТ"'));
 for patch in select value from jsonb_array_elements('[
  {"number":0},{"number":1.5},{"number":2},{"unit":"banana"},{"hsCode":"1806"},
  {"description":""},{"quantity":null},{"quantity":-1},{"quantity":"10"},{"warnings":[{}]}
 ]') loop
  bad:=jsonb_set(good,'{items,0}',good#>'{items,0}'||patch);
  update public.shipment_source_extractions set status='needs_review',confirmed_data='{}',extracted_data=jsonb_build_object('customs_record',bad)
   where id='eb603000-0000-4000-8000-000000000001';
  select to_jsonb(e) into snapshot from public.shipment_source_extractions e where id='eb603000-0000-4000-8000-000000000001';
  rejected:=false;
  begin
   perform public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',bad,'Проверено на оригинале');
  exception when others then rejected:=true; end;
  assert rejected,'Malformed declaration accepted by RPC: '||patch;
  select to_jsonb(e) into after_state from public.shipment_source_extractions e where id='eb603000-0000-4000-8000-000000000001';
  assert snapshot=after_state,'Rejected review changed data';
  rejected:=false;
  begin
   update public.shipment_source_extractions set status='confirmed',confirmed_data=jsonb_build_object('customs_record',bad,'customs_review_note','Проверено на оригинале') where id='eb603000-0000-4000-8000-000000000001';
  exception when others then rejected:=true; end;
  assert rejected,'Malformed declaration bypassed trigger';
 end loop;
 for bad in select value from jsonb_array_elements(jsonb_build_array(
   jsonb_set(good,'{fields}','[{}]'),jsonb_set(good,'{fields}','[null]'),
   jsonb_set(good,'{fields}','[{"label":"Номер","value":0}]'),
   jsonb_set(good,'{warnings}','{}'),jsonb_set(good,'{warnings}','[false]'),
   good||jsonb_build_object('expectedCount',2,'items',jsonb_build_array(good#>'{items,0}',good#>'{items,0}'))
 )) loop
  rejected:=false;
  begin perform private.validate_customs_evidence(bad); exception when others then rejected:=true; end;
  assert rejected,'Malformed fields/duplicate rows accepted';
 end loop;
end $$;
rollback;
