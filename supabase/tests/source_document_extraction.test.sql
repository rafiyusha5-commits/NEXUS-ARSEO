-- Source document extraction schema contract (plain PostgreSQL asserts; pgTAP is not required).
\set ON_ERROR_STOP 1
begin;

do $$begin
 assert to_regclass('public.shipment_source_extractions') is not null,'source extraction table exists';
 assert (select relrowsecurity from pg_class where oid='public.shipment_source_extractions'::regclass),'source extraction table has RLS';
 assert to_regprocedure('public.upsert_shipment_source_extraction(uuid,uuid,uuid,text,text,jsonb,jsonb,jsonb,text,text)') is not null,'controlled extraction upsert exists';
 assert to_regprocedure('public.confirm_shipment_source_extraction(uuid)') is not null,'controlled review RPC exists';
 assert not has_table_privilege('anon','public.shipment_source_extractions','SELECT'),'anonymous cannot read extraction data';
 assert has_table_privilege('authenticated','public.shipment_source_extractions','SELECT'),'employees may read through RLS';
 assert not has_table_privilege('authenticated','public.shipment_source_extractions','INSERT'),'employees cannot insert directly';
 assert not has_table_privilege('authenticated','public.shipment_source_extractions','UPDATE'),'employees cannot update directly';
 assert not has_table_privilege('authenticated','public.shipment_source_extractions','DELETE'),'employees cannot delete directly';
 assert (select count(*) from public.document_types where code in ('transport_order','vehicle_document','driver_document','shipment_workbook'))=4,'source and output document types exist';
 assert (select count(*) from public.permissions where code in ('source_documents.extract','source_documents.review'))=2,'source permissions exist';
 assert (select pg_get_constraintdef(oid) ilike '%xlsx%' from pg_constraint where conname='document_generations_output_format_check'),'generation output constraint allows XLSX';
end$$;

rollback;
\echo 'source_document_extraction: all checks passed'
