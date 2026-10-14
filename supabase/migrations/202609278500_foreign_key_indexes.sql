-- Indexes for foreign keys of the tables that grow with every operation. Audit 2026-10-13, finding Н15.
--
-- About 240 foreign keys had no index. Without one, the parent's delete or key change and every query of
-- "the rows of this shipment / batch / item" read the whole child table: unnoticed in the pilot, slow as the
-- movement ledger, the stage history and the marking codes grow. Indexed here are the foreign keys of those
-- growing tables; left out on purpose are references to employees (created_by, decided_by...) and to the
-- currency list, which are neither deleted nor queried this way, and the small reference tables.
--
-- A key that is mostly empty gets a partial index (where ... is not null): a lookup by value, including the
-- foreign key check, uses it, and the empty rows take no space. supabase/tests/foreign_key_indexes.test.sql
-- keeps the list complete for these tables.
begin;

-- the movement ledger: every receipt, sale, transfer, write-off, return and their reversals
create index if not exists inventory_movements_shipment_idx on public.inventory_movements(shipment_id) where shipment_id is not null;
create index if not exists inventory_movements_shipment_item_idx on public.inventory_movements(shipment_item_id) where shipment_item_id is not null;
create index if not exists inventory_movements_sale_item_idx on public.inventory_movements(sale_item_id) where sale_item_id is not null;
create index if not exists inventory_movements_operation_line_idx on public.inventory_movements(inventory_operation_line_id) where inventory_operation_line_id is not null;
create index if not exists inventory_movements_from_warehouse_idx on public.inventory_movements(from_warehouse_id) where from_warehouse_id is not null;
create index if not exists inventory_movements_to_warehouse_idx on public.inventory_movements(to_warehouse_id) where to_warehouse_id is not null;
create index if not exists inventory_movements_from_location_idx on public.inventory_movements(from_location_id) where from_location_id is not null;
create index if not exists inventory_movements_to_location_idx on public.inventory_movements(to_location_id) where to_location_id is not null;

-- stock, batches and reservations
create index if not exists inventory_balances_location_idx on public.inventory_balances(warehouse_location_id) where warehouse_location_id is not null;
create index if not exists inventory_batches_source_item_idx on public.inventory_batches(source_shipment_item_id) where source_shipment_item_id is not null;
create index if not exists inventory_batches_cost_calculation_idx on public.inventory_batches(cost_calculation_id) where cost_calculation_id is not null;
create index if not exists inventory_reservations_balance_idx on public.inventory_reservations(inventory_balance_id);
create index if not exists inventory_reservations_batch_idx on public.inventory_reservations(batch_id);
create index if not exists inventory_operation_lines_balance_idx on public.inventory_operation_lines(source_balance_id);
create index if not exists inventory_operation_lines_batch_idx on public.inventory_operation_lines(batch_id);
create index if not exists inventory_operation_lines_from_location_idx on public.inventory_operation_lines(from_location_id) where from_location_id is not null;
create index if not exists inventory_operation_lines_to_location_idx on public.inventory_operation_lines(to_location_id) where to_location_id is not null;

-- shipments: items, stages and their history, receipts
create index if not exists shipment_items_product_idx on public.shipment_items(product_id);
create index if not exists shipment_items_transport_idx on public.shipment_items(shipment_transport_id) where shipment_transport_id is not null;
create index if not exists shipment_stage_runs_stage_idx on public.shipment_stage_runs(stage_id);
create index if not exists shipment_stage_runs_transport_idx on public.shipment_stage_runs(shipment_transport_id) where shipment_transport_id is not null;
create index if not exists shipment_stage_history_shipment_idx on public.shipment_stage_history(shipment_id, created_at desc);
create index if not exists shipment_stage_history_run_idx on public.shipment_stage_history(stage_run_id);
create index if not exists shipment_transport_receipt_items_batch_idx on public.shipment_transport_receipt_items(inventory_batch_id) where inventory_batch_id is not null;
create index if not exists shipment_transport_receipt_items_movement_idx on public.shipment_transport_receipt_items(inventory_movement_id) where inventory_movement_id is not null;
create index if not exists cost_calculation_items_item_idx on public.cost_calculation_items(shipment_item_id);
create index if not exists cost_calculation_items_product_idx on public.cost_calculation_items(product_id);
create index if not exists expense_allocations_batch_idx on public.expense_allocations(batch_id) where batch_id is not null;

-- sales, returns, guarantee letters, bank statements
create index if not exists sales_warehouse_idx on public.sales(warehouse_id);
create index if not exists sales_contract_idx on public.sales(contract_id) where contract_id is not null;
create index if not exists sale_items_product_idx on public.sale_items(product_id);
create index if not exists customer_return_items_sale_item_idx on public.customer_return_items(sale_item_id);
create index if not exists customer_return_items_movement_idx on public.customer_return_items(inventory_movement_id) where inventory_movement_id is not null;
create index if not exists customer_return_items_location_idx on public.customer_return_items(warehouse_location_id) where warehouse_location_id is not null;
create index if not exists guarantee_letter_items_sale_item_idx on public.guarantee_letter_items(sale_item_id);
create index if not exists guarantee_letter_items_batch_idx on public.guarantee_letter_items(batch_id);
create index if not exists bank_statement_lines_import_idx on public.bank_statement_lines(import_id);
create index if not exists bank_statement_lines_sale_idx on public.bank_statement_lines(sale_id) where sale_id is not null;

-- marking codes (one row per unit) and notifications
create index if not exists marking_codes_order_idx on public.marking_codes(marking_code_order_id);
create index if not exists marking_codes_product_idx on public.marking_codes(product_id);
create index if not exists marking_codes_batch_idx on public.marking_codes(batch_id) where batch_id is not null;
create index if not exists marking_codes_shipment_idx on public.marking_codes(shipment_id) where shipment_id is not null;
create index if not exists notifications_shipment_idx on public.notifications(shipment_id) where shipment_id is not null;
create index if not exists notification_deliveries_notification_idx on public.notification_deliveries(notification_id);

commit;
