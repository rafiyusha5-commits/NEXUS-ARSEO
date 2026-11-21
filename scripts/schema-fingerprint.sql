-- Read-only fingerprint of the Nexus schema (audit 2026-11-11, K3): one line per object,
-- "kind<TAB>name<TAB>md5<TAB>md5 without whitespace".
-- Run with: psql -X -At -F "<TAB>" -f scripts/schema-fingerprint.sql  (inside a read-only transaction below).
-- Compare two outputs with scripts/schema-diff.mts: a production database against a reference built by applying
-- every migration once in order. Only the structure is read, never table contents, except two seeded catalogues
-- (permission codes, storage buckets), which migrations create.
--
-- Normalised so that a production Supabase project and a local PostgreSQL with supabase/tests/supabase_stub.sql
-- compare equal when the migrations agree: only schemas public and private (plus policies of storage.objects),
-- grants only of the API roles (anon, authenticated, service_role, PUBLIC), columns by name, not by position.
-- Ignored as noise: functions of extensions (pgcrypto lives in "extensions" on Supabase, in "public" locally), the
-- MAINTAIN privilege (PostgreSQL 17 only) and carriage returns in function bodies (some were applied from CRLF files).
begin transaction read only;

with
api_roles(oid, name) as (
  select 0::oid, 'PUBLIC' union all
  select oid, rolname from pg_roles where rolname in ('anon', 'authenticated', 'service_role')
),
schemas as (select oid, nspname, nspacl, nspowner from pg_namespace where nspname in ('public', 'private')),
acl_text(kind, obj, txt) as (
  -- Grants of the API roles of a relation, function or schema, sorted.
  select 'relation', c.oid, coalesce((select string_agg(r.name || ':' || a.privilege_type, ',' order by r.name, a.privilege_type)
           from aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a join api_roles r on r.oid = a.grantee where a.privilege_type <> 'MAINTAIN'), '')
    from pg_class c join schemas s on s.oid = c.relnamespace
  union all
  select 'function', p.oid, coalesce((select string_agg(r.name || ':' || a.privilege_type, ',' order by r.name, a.privilege_type)
           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a join api_roles r on r.oid = a.grantee where a.privilege_type <> 'MAINTAIN'), '')
    from pg_proc p join schemas s on s.oid = p.pronamespace
),
items(kind, name, body) as (
  -- text, not name: the type of the first branch is the type of the column, and name cuts values at 63 bytes.
  select 'schema'::text, n.nspname::text,
         coalesce((select string_agg(r.name || ':' || a.privilege_type, ',' order by r.name, a.privilege_type)
                     from aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a join api_roles r on r.oid = a.grantee where a.privilege_type <> 'MAINTAIN'), '')
    from schemas n
  union all
  -- Tables, views, materialized views, sequences: kind, RLS flags and API grants.
  select case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'matview' when 'S' then 'sequence' end,
         s.nspname || '.' || c.relname,
         concat_ws('|', c.relrowsecurity, c.relforcerowsecurity, g.txt,
                   case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid) end)
    from pg_class c join schemas s on s.oid = c.relnamespace join acl_text g on g.kind = 'relation' and g.obj = c.oid
   where c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all
  -- Columns by name: type, not null, default, column grants of the API roles.
  select 'column', s.nspname || '.' || c.relname || '.' || a.attname,
         concat_ws('|', format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid),
                   coalesce((select string_agg(r.name || ':' || x.privilege_type, ',' order by r.name, x.privilege_type)
                               from aclexplode(a.attacl) x join api_roles r on r.oid = x.grantee where x.privilege_type <> 'MAINTAIN'), ''))
    from pg_attribute a join pg_class c on c.oid = a.attrelid join schemas s on s.oid = c.relnamespace
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where c.relkind in ('r', 'p', 'v', 'm') and a.attnum > 0 and not a.attisdropped
  union all
  select 'constraint', s.nspname || '.' || c.relname || '.' || k.conname, pg_get_constraintdef(k.oid)
    from pg_constraint k join pg_class c on c.oid = k.conrelid join schemas s on s.oid = c.relnamespace
  union all
  select 'index', i.schemaname || '.' || i.indexname, i.indexdef
    from pg_indexes i where i.schemaname in ('public', 'private')
  union all
  select 'trigger', s.nspname || '.' || c.relname || '.' || t.tgname, concat_ws('|', pg_get_triggerdef(t.oid), t.tgenabled)
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join schemas s on s.oid = c.relnamespace
   where not t.tgisinternal
  union all
  -- Policies of the two schemas and of storage.objects (document buckets).
  select 'policy', p.schemaname || '.' || p.tablename || '.' || p.policyname,
         concat_ws('|', p.permissive, p.cmd, array_to_string(array(select unnest(p.roles) order by 1), ','), p.qual, p.with_check)
    from pg_policies p
   where p.schemaname in ('public', 'private') or (p.schemaname = 'storage' and p.tablename = 'objects')
  union all
  -- Functions and procedures: the whole definition (body, SECURITY DEFINER, search_path) and API grants.
  select case p.prokind when 'p' then 'procedure' else 'function' end,
         s.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
         concat_ws('|', replace(pg_get_functiondef(p.oid), E'\r', ''), g.txt)
    from pg_proc p join schemas s on s.oid = p.pronamespace join acl_text g on g.kind = 'function' and g.obj = p.oid
   where p.prokind in ('f', 'p')
     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  union all
  select 'enum', s.nspname || '.' || t.typname, array_to_string(array(select e.enumlabel from pg_enum e where e.enumtypid = t.oid order by e.enumsortorder), ',')
    from pg_type t join schemas s on s.oid = t.typnamespace where t.typtype = 'e'
  union all
  select 'domain', s.nspname || '.' || t.typname, concat_ws('|', format_type(t.typbasetype, t.typtypmod), t.typnotnull,
         array_to_string(array(select pg_get_constraintdef(k.oid) from pg_constraint k where k.contypid = t.oid order by k.conname), ';'))
    from pg_type t join schemas s on s.oid = t.typnamespace where t.typtype = 'd'
  union all
  -- Seeded catalogues: permission codes and storage buckets (not who has which permission: that is managed in Nexus).
  select 'permission', p.code, concat_ws('|', p.module, p.action) from public.permissions p
  union all
  select 'bucket', b.id, concat_ws('|', b.public, b.file_size_limit, array_to_string(b.allowed_mime_types, ',')) from storage.buckets b
)
-- The second hash ignores all whitespace: a definition applied from a differently formatted file still matches it.
select kind, name, md5(coalesce(body, '')), md5(regexp_replace(coalesce(body, ''), '\s+', '', 'g')) from items order by kind, name;

rollback;
