-- Never run against a working project. All examples are synthetic and rolled back.
\set ON_ERROR_STOP 1
begin;
\ir fixtures/source_integrity.sql
create function pg_temp.reject_unchanged(p_sql text) returns void language plpgsql as $$
declare before_state jsonb; after_state jsonb; rejected boolean:=false;
begin
 select jsonb_agg(to_jsonb(e) order by id) into before_state from public.shipment_source_extractions e;
 begin execute p_sql; exception when others then rejected:=true; end;
 if not rejected then raise exception 'STALE SOURCE ACCEPTED: %',p_sql;end if;
 select jsonb_agg(to_jsonb(e) order by id) into after_state from public.shipment_source_extractions e;
 if before_state is distinct from after_state then raise exception 'Rejected call changed extraction';end if;
end $$;
grant execute on function pg_temp.reject_unchanged(text) to authenticated;
select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);
savepoint state;
update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='eb503000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"TEST"}',false)$call$);
select pg_temp.reject_unchanged($call$select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice','extracted','{"invoice_number":"OLD"}')$call$);
select pg_temp.reject_unchanged($call$select public.begin_shipment_source_ocr('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'test','1')$call$);
reset role; update public.shipment_source_extractions set status='pending',extraction_method='ocr' where id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.finish_shipment_source_ocr('eb603000-0000-4000-8000-000000000001','extracted','{"invoice_number":"OLD"}')$call$);
reset role;rollback to state;
savepoint state;
update public.documents set status='rejected' where id='eb503000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"TEST"}',false)$call$);
select pg_temp.reject_unchanged($call$select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice','extracted','{"invoice_number":"OLD"}')$call$);
select pg_temp.reject_unchanged($call$select public.begin_shipment_source_ocr('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'test','1')$call$);
reset role; update public.shipment_source_extractions set status='pending',extraction_method='ocr' where id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.finish_shipment_source_ocr('eb603000-0000-4000-8000-000000000001','extracted','{"invoice_number":"OLD"}')$call$);
reset role;rollback to state;
savepoint state;
update public.documents set archived_at=now(),archived_by='eb000000-0000-4000-8000-000000000001',archive_reason='Synthetic test' where id='eb503000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"TEST"}',false)$call$);
select pg_temp.reject_unchanged($call$select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice','extracted','{"invoice_number":"OLD"}')$call$);
select pg_temp.reject_unchanged($call$select public.begin_shipment_source_ocr('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'test','1')$call$);
reset role; update public.shipment_source_extractions set status='pending',extraction_method='ocr' where id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.finish_shipment_source_ocr('eb603000-0000-4000-8000-000000000001','extracted','{"invoice_number":"OLD"}')$call$);
reset role;rollback to state;
savepoint state;
update public.document_versions set is_current=false where id='eb513000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"TEST"}',false)$call$);
select pg_temp.reject_unchanged($call$select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice','extracted','{"invoice_number":"OLD"}')$call$);
select pg_temp.reject_unchanged($call$select public.begin_shipment_source_ocr('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'test','1')$call$);
reset role; update public.shipment_source_extractions set status='pending',extraction_method='ocr' where id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.finish_shipment_source_ocr('eb603000-0000-4000-8000-000000000001','extracted','{"invoice_number":"OLD"}')$call$);
reset role;rollback to state;
savepoint state;
update public.documents set current_version=2 where id='eb503000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"TEST"}',false)$call$);
select pg_temp.reject_unchanged($call$select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice','extracted','{"invoice_number":"OLD"}')$call$);
select pg_temp.reject_unchanged($call$select public.begin_shipment_source_ocr('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'test','1')$call$);
reset role; update public.shipment_source_extractions set status='pending',extraction_method='ocr' where id='eb603000-0000-4000-8000-000000000001';
set role authenticated;
select pg_temp.reject_unchanged($call$select public.finish_shipment_source_ocr('eb603000-0000-4000-8000-000000000001','extracted','{"invoice_number":"OLD"}')$call$);
reset role;rollback to state;
-- Valid current source may be confirmed without changing shipment quantities.
set role authenticated;
select public.review_shipment_source_extraction('eb603000-0000-4000-8000-000000000001','{"invoice_number":"TEST"}',false);
reset role;
do $$begin
 if (select status from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001')<>'confirmed' then raise exception 'Current source refused';end if;
 if exists(select 1 from public.shipment_items where confirmed_quantity is not null or shipped_quantity is not null) then raise exception 'Review wrote quantities';end if;
end$$;
-- v2 is current: delayed text/OCR v1 must not supersede it.
update public.document_versions set is_current=false where id='eb513000-0000-4000-8000-000000000001';
update public.documents set current_version=2 where id='eb503000-0000-4000-8000-000000000001';
set session_replication_role=replica;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select 'eb513000-0000-4000-8000-000000000002',document_id,2,replace(storage_path,'d.pdf','v2.pdf'),'v2.pdf',mime_type,file_size_bytes,true,uploaded_by from public.document_versions where id='eb513000-0000-4000-8000-000000000001';
set session_replication_role=origin;
set role authenticated;
select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000002','invoice','extracted','{"invoice_number":"NEW"}');
select pg_temp.reject_unchanged($call$select public.upsert_shipment_source_extraction('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice','extracted','{"invoice_number":"OLD"}')$call$);
select pg_temp.reject_unchanged($call$select public.begin_shipment_source_ocr('eb300000-0000-4000-8000-000000000001','eb503000-0000-4000-8000-000000000001','eb513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'test','1')$call$);
reset role;
do $$begin
 if not exists(select 1 from public.shipment_source_extractions where document_version_id='eb513000-0000-4000-8000-000000000002' and status='extracted' and extracted_data->>'invoice_number'='NEW') then raise exception 'v2 damaged by old worker';end if;
end$$;
-- Rejected source is absent from findings even when it has unreviewed data.
update public.shipment_source_extractions set status='needs_review' where document_version_id='eb513000-0000-4000-8000-000000000002';
do $$begin
 if not exists(select 1 from private.document_check_findings('eb300000-0000-4000-8000-000000000001',current_date) f where f::text like '%eb503000%') then raise exception 'Fixture has no finding';end if;
end$$;
update public.documents set status='rejected' where id='eb503000-0000-4000-8000-000000000001';
do $$begin
 if exists(select 1 from private.document_check_findings('eb300000-0000-4000-8000-000000000001',current_date) f where f::text like '%eb503000%') then raise exception 'Rejected document used by checker';end if;
end$$;
rollback;
