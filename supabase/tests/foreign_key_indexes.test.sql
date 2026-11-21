-- Foreign keys of the growing tables have an index (202609278500, audit finding Н15). A new foreign key on one of
-- these tables needs its index too, or this test names it. References to employees and to the currency list are
-- left out on purpose: they are neither deleted nor queried by value.
\set ON_ERROR_STOP 1

do $$
declare
  c_tables constant text[] := array[
    'inventory_movements','inventory_balances','inventory_batches','inventory_reservations','inventory_operation_lines',
    'shipment_items','shipment_stage_runs','shipment_stage_history','shipment_transport_receipt_items',
    'cost_calculation_items','expense_allocations','sales','sale_items','customer_return_items','guarantee_letter_items',
    'bank_statement_lines','marking_codes','notifications','notification_deliveries'];
  v_missing text;
begin
  assert (select count(*) from unnest(c_tables) t where to_regclass('public.'||t) is null)=0, 'every listed table exists';
  select string_agg(format('%s(%s) -> %s', c.conrelid::regclass, cols.names, c.confrelid::regclass), '; ' order by 1)
  into v_missing
  from pg_constraint c
  join pg_class t on t.oid=c.conrelid
  join pg_namespace n on n.oid=t.relnamespace and n.nspname='public'
  cross join lateral (select string_agg(a.attname, ',' order by k.ord) names
    from unnest(c.conkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum) cols
  where c.contype='f' and t.relname=any(c_tables)
    and c.confrelid not in ('public.profiles'::regclass, 'auth.users'::regclass, 'public.currencies'::regclass)
    and not exists(
      select 1 from pg_index i
      where i.indrelid=c.conrelid and i.indisvalid
        and (i.indkey::int2[])[0:cardinality(c.conkey)-1] @> c.conkey
        and (i.indkey::int2[])[0:cardinality(c.conkey)-1] <@ c.conkey);
  if v_missing is not null then raise exception 'foreign keys without an index: %', v_missing; end if;
end $$;

-- The foreign key check and a lookup by value use the partial index of a mostly empty key.
begin;
set local enable_seqscan=off;
do $$ declare v_plan text:=''; v_line text; begin
  for v_line in execute 'explain (costs off) select 1 from only public.inventory_movements x where ''00000000-0000-0000-0000-000000000000''::uuid operator(pg_catalog.=) shipment_item_id for key share of x' loop
    v_plan:=v_plan||v_line||' ';
  end loop;
  assert v_plan ~ 'inventory_movements_shipment_item_idx', format('the foreign key check uses the partial index: %s', v_plan);
end $$;
rollback;

\echo 'foreign_key_indexes: all checks passed'
