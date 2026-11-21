-- 202611190100 and 202611210400 (audit 2026-11-11, K7): every foreign key in the public and private schemas has an
-- index that starts with its columns. A new table with a foreign key needs its index in the same migration.
-- Read-only check of the catalog.
\set ON_ERROR_STOP 1
do $$
declare v_missing text;
begin
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ' order by 1) into v_missing
    from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where c.contype = 'f' and n.nspname in ('public', 'private')
     and not exists (
       select 1 from pg_index i
        where i.indrelid = c.conrelid
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey);
  assert v_missing is null, format('foreign keys without an index: %s', v_missing);
end $$;
\echo all_foreign_key_indexes: all checks passed
