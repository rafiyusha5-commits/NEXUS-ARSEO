-- External client isolation, explicit permissions and document sharing.
\set ON_ERROR_STOP 1
begin;

do $$begin
 assert not has_function_privilege('anon','public.my_external_document_permissions()','execute'),'anon cannot call portal RPCs';
 assert not has_function_privilege('service_role','public.configure_external_client(uuid,uuid,text,text,text,boolean,boolean,boolean)','execute'),'service role has no implicit portal administration RPC';
 assert has_function_privilege('authenticated','public.my_external_document_permissions()','execute'),'signed-in portal users can read their explicit flags';
end$$;

insert into auth.users(id,email,raw_user_meta_data) values
 ('fd000000-0000-4000-8000-000000000001','portal-manager@test.local','{"full_name":"Portal Manager"}'),
 ('fd000000-0000-4000-8000-000000000002','client-a@test.local','{"full_name":"Client A"}'),
 ('fd000000-0000-4000-8000-000000000003','client-b@test.local','{"full_name":"Client B"}');
insert into public.user_roles(user_id,role_id) select 'fd000000-0000-4000-8000-000000000001',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('fd100000-0000-4000-8000-000000000001',array['customer'],'Portal Customer A','KZ','PORTAL-A'),
 ('fd100000-0000-4000-8000-000000000002',array['customer'],'Portal Customer B','KZ','PORTAL-B');

set role authenticated;
select set_config('request.jwt.claim.sub','fd000000-0000-4000-8000-000000000001',false);
select public.configure_external_client('fd000000-0000-4000-8000-000000000002','fd100000-0000-4000-8000-000000000001','Client A','+77010000001','ru',true,true,true);
select public.configure_external_client('fd000000-0000-4000-8000-000000000003','fd100000-0000-4000-8000-000000000002','Client B','+77010000002','ru',true,true,false);

reset role;
insert into public.documents(id,document_type_id,title,status,counterparty_id,visibility,source,uploaded_by) values
 ('fd200000-0000-4000-8000-000000000001',(select id from public.document_types where is_active order by sort_order limit 1),'A shared','approved','fd100000-0000-4000-8000-000000000001','shared_with_counterparty','manual_upload','fd000000-0000-4000-8000-000000000001'),
 ('fd200000-0000-4000-8000-000000000002',(select id from public.document_types where is_active order by sort_order limit 1),'A internal','approved','fd100000-0000-4000-8000-000000000001','internal','manual_upload','fd000000-0000-4000-8000-000000000001'),
 ('fd200000-0000-4000-8000-000000000003',(select id from public.document_types where is_active order by sort_order limit 1),'B shared','approved','fd100000-0000-4000-8000-000000000002','shared_with_counterparty','manual_upload','fd000000-0000-4000-8000-000000000001');

set role authenticated;
select set_config('request.jwt.claim.sub','fd000000-0000-4000-8000-000000000002',false);
do $$begin
 assert (select private.is_external_client()),'client A is a valid external account';
 assert (select count(*)=1 from public.documents),'client A sees only one shared own document';
 assert (select min(title)='A shared' from public.documents),'client A cannot see internal or another customer document';
 assert (select count(*)=1 from public.profiles),'external user sees only own profile';
 assert (select count(*)=0 from public.app_roles),'external user cannot enumerate roles';
 assert (select count(*)=0 from public.permissions),'external user cannot enumerate permissions';
 assert (select count(*)=0 from public.role_permissions),'external user cannot enumerate role permission matrix';
 assert (select (public.my_external_document_permissions()->>'download')::boolean),'download permission is explicit';
end$$;
select public.record_external_document_access('fd200000-0000-4000-8000-000000000001','view');
select public.update_my_external_profile('kk','+77019999999');
do $$begin
 update public.documents set title='tampered' where id='fd200000-0000-4000-8000-000000000001';
 assert (select title='A shared' from public.documents where id='fd200000-0000-4000-8000-000000000001'),'external user cannot update a shared document';
 assert (select locale='kk' and phone='+77019999999' from public.profiles where id='fd000000-0000-4000-8000-000000000002'),'external user updates only own allowed profile fields';
end$$;

select set_config('request.jwt.claim.sub','fd000000-0000-4000-8000-000000000001',false);
select public.set_external_client_access('fd000000-0000-4000-8000-000000000002',false,false,true);
select set_config('request.jwt.claim.sub','fd000000-0000-4000-8000-000000000002',false);
do $$declare denied boolean:=false;begin
 assert (select count(*)=0 from public.documents),'revoked view hides previously visible documents';
 assert not (select (public.my_external_document_permissions()->>'view')::boolean),'revoked permission is effective immediately';
 begin perform public.record_external_document_access('fd200000-0000-4000-8000-000000000001','view');exception when raise_exception then denied:=true;end;
 assert denied,'revoked view must reject audit call';
end$$;

reset role;
rollback;
select 'external_client_portal: passed' as result;
