\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create temp table leases(label text,lease timestamptz);
grant all on leases to authenticated;
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
insert into leases select 'old',(public.begin_shipment_source_ocr(
 'eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',
 'invoice',repeat('a',64),'synthetic','v1',3,60,false)->>'lease_started_at')::timestamptz;
reset role;
update public.shipment_source_extractions set processing_started_at=clock_timestamp()-interval '2 minutes'
 where id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
insert into leases select 'new',(public.begin_shipment_source_ocr(
 'eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001',
 'invoice',repeat('a',64),'synthetic','v1',3,60,false)->>'lease_started_at')::timestamptz;
do $$declare rejected boolean:=false;begin
 begin
  perform public.finish_shipment_source_ocr_fenced('eb603000-0000-4000-8000-000000000001',(select lease from leases where label='old'),'extracted','{"invoice_number":"STALE"}');
 exception when others then rejected:=true; end;
 assert rejected,'old process must not finish a new lease';
 assert (select status='pending' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001');
 assert not has_function_privilege('authenticated','public.finish_shipment_source_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text)','execute');
end $$;
select public.finish_shipment_source_ocr_fenced('eb603000-0000-4000-8000-000000000001',(select lease from leases where label='new'),'extracted','{"invoice_number":"CURRENT"}');
do $$begin
 assert (select extracted_data->>'invoice_number'='CURRENT' and status='extracted' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001');
end $$;
rollback;
