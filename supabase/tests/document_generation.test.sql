-- Permissions and immutable provenance for automatic DOCX generation.
\set ON_ERROR_STOP 1

do $$
begin
  assert (select relrowsecurity from pg_class where oid='public.document_generations'::regclass),
    'document_generations must use RLS';
  assert has_table_privilege('authenticated','public.document_generations','select'),
    'employees need controlled read access to generation provenance';
  assert not has_table_privilege('authenticated','public.document_generations','insert')
     and not has_table_privilege('authenticated','public.document_generations','update')
     and not has_table_privilege('authenticated','public.document_generations','delete'),
    'generation provenance must only be written by the registration RPC';
  assert has_function_privilege('authenticated',
    'public.register_generated_document(uuid,uuid,uuid,uuid,uuid,text,text,text,text,date,text,text,boolean,jsonb)','execute'),
    'authenticated users need the guarded registration RPC';
  assert not has_function_privilege('anon',
    'public.register_generated_document(uuid,uuid,uuid,uuid,uuid,text,text,text,text,date,text,text,boolean,jsonb)','execute'),
    'anonymous users must not generate documents';
  assert has_function_privilege('authenticated','private.can_view_generated_document(uuid)','execute')
     and has_function_privilege('authenticated','private.can_read_registered_document_file(text,text)','execute'),
    'RLS and Storage need the guarded visibility helpers';
end;
$$;

insert into auth.users(id,email,raw_user_meta_data) values
 ('35000000-0000-4000-8000-000000000001','generation-director@test.local','{"full_name":"Generation Director"}'),
 ('35000000-0000-4000-8000-000000000002','generation-logistics@test.local','{"full_name":"Generation Logistics"}');
insert into public.user_roles(user_id,role_id)
select v.user_id::uuid,r.id from (values
 ('35000000-0000-4000-8000-000000000001','director'),
 ('35000000-0000-4000-8000-000000000002','logistics_specialist')
) v(user_id,role_code) join public.app_roles r on r.code=v.role_code;

select set_config('request.jwt.claim.sub','35000000-0000-4000-8000-000000000001',false);
set role authenticated;
do $$ begin
 assert (select private.has_permission('templates.generate'));
 assert (select private.has_permission('templates.generate_prices'));
end $$;
reset role;

select set_config('request.jwt.claim.sub','35000000-0000-4000-8000-000000000002',false);
set role authenticated;
do $$ begin
 assert (select private.has_permission('templates.generate'));
 assert not (select private.has_permission('templates.generate_prices')),
   'logistics may generate operational documents but may not expose purchase prices';
end $$;
reset role;
