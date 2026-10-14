-- Runs on the schema BEFORE 202609278500_foreign_key_indexes.sql and proves the defect it fixes: foreign keys of the
-- growing tables have no index, so the foreign key check reads the whole movement ledger.
-- supabase/tests/foreign_key_indexes.test.sql proves they are indexed afterwards.
\set ON_ERROR_STOP 1
begin;
set local enable_seqscan=off;
do $$ declare v_plan text:=''; v_line text; begin
  assert not exists(select 1 from pg_index i where i.indrelid='public.inventory_movements'::regclass
    and i.indkey[0]=(select attnum from pg_attribute where attrelid='public.inventory_movements'::regclass and attname='shipment_item_id')),
    'BEFORE: inventory_movements.shipment_item_id has no index';
  for v_line in execute 'explain (costs off) select 1 from only public.inventory_movements x where ''00000000-0000-0000-0000-000000000000''::uuid operator(pg_catalog.=) shipment_item_id for key share of x' loop
    v_plan:=v_plan||v_line||' ';
  end loop;
  assert v_plan ~ 'Seq Scan', format('BEFORE: the foreign key check reads the whole ledger: %s', v_plan);
end $$;
rollback;
