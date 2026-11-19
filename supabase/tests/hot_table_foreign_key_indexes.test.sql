-- 202611190100: every foreign key of the hot tables of K7 has an index that starts with its columns.
-- Read-only check of the catalog.
\set ON_ERROR_STOP 1
do $$
declare v_missing text;
begin
  select string_agg(format('%s(%s)', c.conrelid::regclass, c.conname), ', ' order by 1) into v_missing
    from pg_constraint c
   where c.contype = 'f'
     and c.conrelid in ('public.inventory_movements'::regclass, 'public.inventory_reservations'::regclass,
                        'public.sale_items'::regclass, 'public.shipment_items'::regclass,
                        'public.document_links'::regclass, 'public.notifications'::regclass)
     and not exists (
       select 1 from pg_index i
        where i.indrelid = c.conrelid
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
          and (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey);
  assert v_missing is null, format('foreign keys of hot tables without an index: %s', v_missing);
end $$;
\echo hot_table_foreign_key_indexes: all checks passed
