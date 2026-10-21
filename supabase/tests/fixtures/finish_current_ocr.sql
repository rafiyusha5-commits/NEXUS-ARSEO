-- Test-only adapter for existing validation/access cases. Real workers retain the lease from begin;
-- takeover/stale-worker tests below call the public fenced RPC directly with the OLD lease.
create or replace function pg_temp.finish_current_ocr(
 p_extraction_id uuid,p_status text,p_extracted_data jsonb default '{}'::jsonb,p_field_evidence jsonb default '{}'::jsonb,
 p_conflicts jsonb default '[]'::jsonb,p_error_message text default null,p_extractor_version text default 'ocr-v1',
 p_page_count integer default null,p_processing_ms integer default null,p_confidence numeric default null,p_source_kind text default null
) returns uuid language sql security invoker as $$
 select public.finish_shipment_source_ocr_fenced(p_extraction_id,
 (select processing_started_at from public.shipment_source_extractions where id=p_extraction_id),p_status,p_extracted_data,
 p_field_evidence,p_conflicts,p_error_message,p_extractor_version,p_page_count,p_processing_ms,p_confidence,p_source_kind);
$$;
grant execute on function pg_temp.finish_current_ocr(uuid,text,jsonb,jsonb,jsonb,text,text,integer,integer,numeric,text) to authenticated;
