select jsonb_build_object(
 'tables',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,
   pg_get_userbyid(c.relowner),(select jsonb_agg(x::text order by x::text) from unnest(c.relacl) x)) order by n.nspname,c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage') and c.relkind in ('r','v','S')),
 'policies',(select jsonb_agg(to_jsonb(p) order by schemaname,tablename,policyname) from pg_policies p where schemaname in ('public','private','auth','storage')),
 'constraints',(select jsonb_agg(jsonb_build_array(n.nspname,c.relname,k.conname,pg_get_constraintdef(k.oid)) order by n.nspname,c.relname,k.conname)
   from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','auth','storage')),
 'functions',(select jsonb_agg(jsonb_build_array(n.nspname,p.proname,pg_get_function_identity_arguments(p.oid),p.prosecdef,pg_get_functiondef(p.oid),
   pg_get_userbyid(p.proowner),(select jsonb_agg(x::text order by x::text) from unnest(p.proacl) x)) order by n.nspname,p.proname,pg_get_function_identity_arguments(p.oid))
   from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.prokind='f'),
 'defaults',(select jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype,
   (select jsonb_agg(x::text order by x::text) from unnest(d.defaclacl) x)) order by pg_get_userbyid(d.defaclrole),n.nspname,d.defaclobjtype)
   from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where n.nspname in ('public','private','auth','storage')),
 'sequences',(select jsonb_agg(to_jsonb(s) order by schemaname,sequencename) from pg_sequences s where schemaname in ('public','private','auth','storage'))
);
