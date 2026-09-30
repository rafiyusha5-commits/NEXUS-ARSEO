begin;

select plan(12);

select has_table('public','shipment_source_extractions','source extraction table exists');
select ok((select relrowsecurity from pg_class where oid='public.shipment_source_extractions'::regclass),'source extraction table has RLS');
select has_function('public','upsert_shipment_source_extraction',array['uuid','uuid','uuid','text','text','jsonb','jsonb','jsonb','text','text'],'controlled extraction upsert exists');
select has_function('public','confirm_shipment_source_extraction',array['uuid'],'controlled review RPC exists');
select hasnt_table_privilege('anon','public.shipment_source_extractions','SELECT','anonymous cannot read extraction data');
select has_table_privilege('authenticated','public.shipment_source_extractions','SELECT','employees may read through RLS');
select hasnt_table_privilege('authenticated','public.shipment_source_extractions','INSERT','employees cannot insert directly');
select hasnt_table_privilege('authenticated','public.shipment_source_extractions','UPDATE','employees cannot update directly');
select hasnt_table_privilege('authenticated','public.shipment_source_extractions','DELETE','employees cannot delete directly');
select results_eq($$select count(*)::bigint from public.document_types where code in ('transport_order','vehicle_document','driver_document','shipment_workbook')$$,$$values (4::bigint)$$,'source and output document types exist');
select results_eq($$select count(*)::bigint from public.permissions where code in ('source_documents.extract','source_documents.review')$$,$$values (2::bigint)$$,'source permissions exist');
select ok((select pg_get_constraintdef(oid) ilike '%xlsx%' from pg_constraint where conname='document_generations_output_format_check'),'generation output constraint allows XLSX');

select * from finish();
rollback;
