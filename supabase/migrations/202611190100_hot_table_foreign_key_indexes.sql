-- K7 of the audit of 2026-11-11 (docs/audit-2026-11-11.md), started with the hot tables only:
-- inventory_movements, inventory_reservations, sale_items, shipment_items, document_links, notifications.
-- On 2026-11-19 the catalog of a database with every migration applied showed seven foreign keys of these tables
-- without an index that starts with their column; sale_items and notifications had none. An index on the
-- referencing column keeps deletes and updates of the referenced rows (profiles, currencies) from scanning the
-- whole table and serves joins on these columns.
-- Plain CREATE INDEX inside the migration transaction: these tables are small today. On a large table the owners
-- may prefer CREATE INDEX CONCURRENTLY outside a transaction instead. No data changes.
begin;

create index if not exists inventory_movements_created_by_idx on public.inventory_movements(created_by);
create index if not exists inventory_reservations_created_by_idx on public.inventory_reservations(created_by);
create index if not exists inventory_reservations_override_approved_by_idx on public.inventory_reservations(override_approved_by);
create index if not exists shipment_items_currency_id_idx on public.shipment_items(currency_id);
create index if not exists shipment_items_discrepancy_accepted_by_idx on public.shipment_items(discrepancy_accepted_by);
create index if not exists document_links_created_by_idx on public.document_links(created_by);
create index if not exists document_links_removed_by_idx on public.document_links(removed_by);

commit;
