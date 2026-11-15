-- 202611150100: the administrator role holds every freight right; nobody else gets them automatically;
-- an access manager can pass a right to another role; a personal deny still wins over the role.
begin;
insert into auth.users(id,email,raw_user_meta_data) values
 ('fa000000-0000-4000-8000-000000000001','freight-rights-admin@example.invalid','{"full_name":"Freight rights admin"}'),
 ('fa000000-0000-4000-8000-000000000002','freight-rights-denied@example.invalid','{"full_name":"Freight rights denied admin"}'),
 ('fa000000-0000-4000-8000-000000000003','freight-rights-director@example.invalid','{"full_name":"Freight rights director"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from auth.users u cross join public.app_roles r
 where (u.id in('fa000000-0000-4000-8000-000000000001','fa000000-0000-4000-8000-000000000002') and r.code='administrator')
    or (u.id='fa000000-0000-4000-8000-000000000003' and r.code='director');
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select 'fa000000-0000-4000-8000-000000000002',id,'deny','Personal deny over the role grant','fa000000-0000-4000-8000-000000000001'
 from public.permissions where code='drivers.documents.view';

do $$
declare rights text[]:=array['carriers.directory.read','carriers.directory.manage','freight.context.read','freight.context.manage','drivers.documents.view'];
begin
 assert (select count(*) from public.role_permissions rp join public.app_roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
   where r.code='administrator' and rp.granted and p.code=any(rights))=5, 'administrator role must hold all five freight rights';
 assert not exists(select 1 from public.role_permissions rp join public.app_roles r on r.id=rp.role_id join public.permissions p on p.id=rp.permission_id
   where r.code<>'administrator' and rp.granted and p.code=any(rights)), 'no other role receives freight rights automatically';
end $$;

-- An administrator without personal overrides: rights through the role, operational archive stays open.
select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000001',true);
set local role authenticated;
do $$begin
 assert (select private.has_permission('drivers.documents.view')), 'administrator holds driver documents through the role';
 assert (select private.has_permission('carriers.directory.manage')), 'administrator manages the directory through the role';
 assert (select private.has_permission('freight.context.manage')), 'administrator manages trips through the role';
end$$;
reset role;
-- The archive helper is not executable by API roles; evaluate it for the same identity as the owner.
do $$begin
 assert (select private.can_read_operational_archive()), 'administrator keeps the operational archive';
end$$;
set local role authenticated;

-- The administrator (roles.manage) passes a right to another role through the ordinary matrix.
insert into public.role_permissions(role_id,permission_id,granted)
 select r.id,p.id,true from public.app_roles r cross join public.permissions p
 where r.code='director' and p.code='carriers.directory.read';
reset role;

select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000003',true);
set local role authenticated;
do $$begin
 assert (select private.has_permission('carriers.directory.read')), 'director receives the right passed by the administrator';
 assert not (select private.has_permission('drivers.documents.view')), 'director does not receive rights that were not passed';
end$$;
reset role;

-- Personal deny is stronger than the role grant.
select set_config('request.jwt.claim.sub','fa000000-0000-4000-8000-000000000002',true);
set local role authenticated;
do $$begin
 assert not (select private.has_permission('drivers.documents.view')), 'personal deny removes driver documents';
 assert (select private.has_permission('carriers.directory.read')), 'deny of one right keeps the others';
end$$;
reset role;
rollback;
\echo freight_administrator_permissions: all checks passed
