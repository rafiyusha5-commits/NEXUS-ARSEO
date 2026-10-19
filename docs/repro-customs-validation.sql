-- Diagnostic ONLY: disposable local database after migrations; never production/training.
-- These assertions reproduce acceptance of malformed evidence on base 0569ff0.
-- Not a passing acceptance suite: after a fix, this reproduction should raise/reject.
\set ON_ERROR_STOP 1
begin;
\ir ../supabase/tests/fixtures/source_integrity.sql
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
update public.shipment_source_extractions set source_kind='other',status='needs_review',
 extracted_data='{"customs_record":{"kind":"declaration","fields":[{"label":"Номер","value":"SYNTH"}],"expectedCount":1,"items":[{"number":1,"sku":"SYNTH-A","quantity":1,"unit":"piece","hsCode":"3924100000","description":"Synthetic","amount":1,"grossKg":1,"netKg":1,"customsValue":1}],"warnings":[]}}',
 confirmed_data='{}',reviewed_by=null,reviewed_at=null where id='eb603000-0000-4000-8000-000000000001';
do $$declare bad jsonb; baseline jsonb; begin
 select extracted_data->'customs_record' into baseline from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001';
 foreach bad in array array[
  jsonb_set(baseline,'{items,0,number}','0'),
  jsonb_set(baseline,'{items,0,number}','1.5'),
  jsonb_set(baseline,'{fields}','[null]'),
  jsonb_set(baseline,'{items,0,unit}','"unknown-unit"'),
  jsonb_set(jsonb_set(baseline,'{expectedCount}','2'),'{items}',jsonb_build_array(baseline#>'{items,0}',baseline#>'{items,0}'))
 ] loop
  begin
   update public.shipment_source_extractions set extracted_data=jsonb_build_object('customs_record',bad)
    where id='eb603000-0000-4000-8000-000000000001';
   set local role authenticated;
   perform public.review_shipment_customs_evidence('eb300000-0000-4000-8000-000000000001','eb603000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',bad,'Синтетический тест некорректных данных');
   reset role;
   assert (select status='confirmed' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'),'Expected current defect: malformed review accepted';
   raise exception using errcode='ZX001',message='rollback synthetic case';
  exception when sqlstate 'ZX001' then null; end;
 end loop;
end $$;
rollback;
