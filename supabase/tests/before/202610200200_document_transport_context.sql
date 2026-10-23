\set ON_ERROR_STOP 1
begin;
\ir ../fixtures/source_integrity.sql
update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001'
where document_id='eb503000-0000-4000-8000-000000000001';
set role authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',true);
select public.assign_source_extraction_transport('eb603000-0000-4000-8000-000000000001','eb310000-0000-4000-8000-000000000001');
do $$begin
 assert (select shipment_transport_id='eb310000-0000-4000-8000-000000000001' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'),
 'baseline: detached document could still be reassigned';
end $$;
rollback;
