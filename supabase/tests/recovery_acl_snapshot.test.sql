\set ON_ERROR_STOP 1
begin;
\ir ../../tests/recovery/schema.sql
do $$declare owner_id oid; original jsonb; changed jsonb; begin
 select oid into owner_id from pg_roles where rolname=current_user;
 assert pg_temp.recovery_acl(null,'r',owner_id)=pg_temp.recovery_acl(acldefault('r',owner_id),'r',owner_id),
   'NULL and explicit default table ACL must compare equal after pg_restore';
 assert pg_temp.recovery_acl(null,'f',owner_id)=pg_temp.recovery_acl(acldefault('f',owner_id),'f',owner_id),
   'NULL function ACL includes the default PUBLIC EXECUTE';
 assert pg_temp.recovery_acl('{}'::aclitem[],'f',owner_id) is distinct from pg_temp.recovery_acl(null,'f',owner_id),
   'An empty ACL is not a default ACL';
 create table public.recovery_acl_probe (visible text, protected text);
 create sequence public.recovery_acl_sequence;
 revoke all on sequence public.recovery_acl_sequence from public,anon,authenticated,service_role;
 assert (select pg_temp.recovery_acl(relacl,'s',relowner)=pg_temp.recovery_acl(null,'s',relowner)
   from pg_class where oid='public.recovery_acl_sequence'::regclass), 'Sequence defaults include SELECT, UPDATE and USAGE';
 revoke all on public.recovery_acl_probe from public,anon,authenticated,service_role;
 original:=pg_temp.recovery_schema();
 grant select(protected) on public.recovery_acl_probe to authenticated;
 changed:=pg_temp.recovery_schema();
 assert original is distinct from changed,'Column grants must be included in restore verification';
 revoke select(protected) on public.recovery_acl_probe from authenticated;
 assert original=pg_temp.recovery_schema(),'Revoked column grant restores the same effective rights';
 grant select on public.recovery_acl_probe to anon;
 assert original is distinct from pg_temp.recovery_schema(),'Unexpected table access must not be normalized away';
end $$;
rollback;
