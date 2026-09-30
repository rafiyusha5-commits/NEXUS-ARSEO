-- Export package registration remains a guarded server operation with PDF provenance.
\set ON_ERROR_STOP 1

do $$
begin
 assert exists(select 1 from pg_constraint where conname='document_generations_output_format_check' and pg_get_constraintdef(oid) like '%pdf%'),
   'generation provenance must support PDF outputs';
 assert has_function_privilege('authenticated','public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb)','execute'),
   'authenticated employees need the guarded package RPC';
 assert not has_function_privilege('anon','public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb)','execute')
    and not has_function_privilege('service_role','public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb)','execute'),
   'anonymous and service roles must not bypass the package permission checks';
 assert proconfig @> array['search_path=""']
   from pg_proc where oid='public.register_generated_document_package(uuid,uuid,uuid,jsonb,boolean,jsonb)'::regprocedure;
end $$;
