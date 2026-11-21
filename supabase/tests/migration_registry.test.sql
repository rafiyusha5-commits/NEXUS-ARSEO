-- 202611210600 and supabase/tools/schema-fingerprint.sql (audit 2026-11-11, K3). Synthetic data only; rolled back.
\set ON_ERROR_STOP 1
-- The read-only schema fingerprint runs on a database with every migration (it opens and closes its own
-- read-only transaction, so it runs before the test transaction).
\set fingerprint :repo_root '/supabase/tools/schema-fingerprint.sql'
\i :fingerprint
begin;
-- 1. The registry is closed to every API role, with RLS on.
do $$begin
 assert (select relrowsecurity from pg_class where oid='private.applied_migrations'::regclass);
 assert not has_table_privilege('anon','private.applied_migrations','select');
 assert not has_table_privilege('authenticated','private.applied_migrations','select');
 assert not has_table_privilege('authenticated','private.applied_migrations','insert');
 assert not has_table_privilege('service_role','private.applied_migrations','select');
end $$;
-- 2. A record is a migration name, a SHA-256, a method and who recorded it; a repeated record changes nothing.
insert into private.applied_migrations(name,sha256,method,recorded_by,note)
 values ('202611190200_calculator_price_blocks.sql',repeat('a',64),'reconciled','Synthetic owner','Сверка схемы');
insert into private.applied_migrations(name,sha256,method,recorded_by)
 values ('202611190200_calculator_price_blocks.sql',repeat('b',64),'applied','Synthetic owner')
 on conflict (name) do nothing;
do $$begin
 assert (select sha256 from private.applied_migrations where name='202611190200_calculator_price_blocks.sql')=repeat('a',64);
end $$;
create function pg_temp.fails(p_sql text) returns void language plpgsql as $$
begin
 begin execute p_sql;exception when check_violation or not_null_violation then return;end;
 raise exception 'expected a constraint error: %',p_sql;
end $$;
select pg_temp.fails($q$insert into private.applied_migrations(name,sha256,method,recorded_by) values ('notes.sql',repeat('a',64),'applied','Owner')$q$);
select pg_temp.fails($q$insert into private.applied_migrations(name,sha256,method,recorded_by) values ('202611210600_x.sql','abc','applied','Owner')$q$);
select pg_temp.fails($q$insert into private.applied_migrations(name,sha256,method,recorded_by) values ('202611210600_x.sql',repeat('a',64),'guessed','Owner')$q$);
select pg_temp.fails($q$insert into private.applied_migrations(name,sha256,method,recorded_by) values ('202611210600_x.sql',repeat('a',64),'applied',' ')$q$);
\echo migration_registry: all checks passed
rollback;
