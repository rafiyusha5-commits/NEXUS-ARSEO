-- pg_dump may replace an explicit owner-only ACL with NULL (the same default
-- privileges). Compare effective ACL entries, not their storage representation.
create function pg_temp.recovery_acl(acl aclitem[],kind "char",owner_id oid) returns jsonb
language sql stable as $$
 select jsonb_agg(x::text order by x::text) from unnest(coalesce(acl,acldefault(kind,owner_id))) x
$$;
create function pg_temp.recovery_schema() returns jsonb language sql stable as $$
select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,
   pg_get_userbyid(c.relowner),pg_temp.recovery_acl(c.relacl,case when c.relkind='S' then 's'::"char" else 'r'::"char" end,c.relowner)) order by n.nspname,c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and c.relkind in ('r','v','S')),
 'columns',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,a.attname,
   (select jsonb_agg(x::text order by x::text) from unnest(a.attacl) x)) order by n.nspname,c.relname,a.attname)
   from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
   where n.nspname in ('public','private','auth','storage') and c.relkind in ('r','v') and a.attnum>0 and not a.attisdropped),
 'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','private','auth','storage')),
 'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid)) order by n.nspname,c.relname,k.conname)
   from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage')),
 'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef,pg_get_functiondef(p.oid),
   pg_get_userbyid(p.proowner),pg_temp.recovery_acl(p.proacl,'f'::"char",p.proowner)) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'),
 'defaults',(select jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype,
   (select jsonb_agg(x::text order by x::text) from unnest(d.defaclacl) x)) order by pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype)
   from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where n.nspname in ('public','private','auth','storage')),
 'sequences',(select jsonb_agg(to_jsonb(s) order by schemaname,sequencename) from pg_sequences s where schemaname in ('public','private','auth','storage'))
);
$$;
select pg_temp.recovery_schema();
