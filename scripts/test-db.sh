#!/usr/bin/env bash
# Applies all Supabase migrations to a throwaway local PostgreSQL cluster (with a
# minimal Supabase stub) and runs the SQL test files from supabase/tests.
# Requires PostgreSQL 15+ server binaries (initdb, pg_ctl) and psql.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-$(pg_config --bindir 2>/dev/null || true)}"
if [[ -z "$PGBIN" || ! -x "$PGBIN/initdb" ]]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
if [[ -z "$PGBIN" || ! -x "$PGBIN/initdb" ]]; then
  echo "PostgreSQL server binaries not found. Set PGBIN to the directory with initdb." >&2
  exit 2
fi

WORKDIR="$(mktemp -d)"
PORT="${PGPORT_TEST:-55439}"
RUN=()
if [[ "$(id -u)" == "0" ]]; then
  chown postgres "$WORKDIR"
  RUN=(runuser -u postgres --)
fi

cleanup() {
  "${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORKDIR/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

# UTF8 like Supabase: with a POSIX locale initdb would pick SQL_ASCII and length() would count bytes.
"${RUN[@]}" "$PGBIN/initdb" -D "$WORKDIR/data" -A trust -U postgres --encoding=UTF8 --locale=C.UTF-8 >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORKDIR/data" -l "$WORKDIR/server.log" \
  -o "-k $WORKDIR -p $PORT -c listen_addresses=''" -w start >/dev/null

# The business day of the application is Kazakhstan's (202609278300): tests live in it too, so that their own
# current_date is the "today" the functions use at any hour. business_date.test.sql sets other session zones itself.
export PGOPTIONS="-c client_min_messages=warning -c timezone=Asia/Almaty"
PSQL=(psql -h "$WORKDIR" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)

"${PSQL[@]}" -f "$ROOT/supabase/tests/supabase_stub.sql"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  # supabase/tests/before/<migration>.sql runs on the schema just before that migration and
  # proves that the problems it fixes were real (it must roll back its own changes).
  before="$ROOT/supabase/tests/before/$(basename "$migration")"
  if [[ -f "$before" ]]; then
    echo "before: $(basename "$migration")"
    "${PSQL[@]}" -v repo_root="$ROOT" -o /dev/null -f "$before"
  fi
  echo "migration: $(basename "$migration")"
  "${PSQL[@]}" -f "$migration"
done

echo "re-applying document migrations (idempotency check)"
# Order matters: 202609271600 redefines my_document_permissions() (adds "approve") and
# apply_document_version() from 202609271001. The final 202609271800 migration restores
# both the scoped Storage policies and the current supplier/buyer template model. The
# superseded 202609271700 schema cannot be re-applied after its columns were renamed.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609271001_document_management.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609271600_document_approvals.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609271800_counterparty_template_directions.sql" >/dev/null
# The reference import only replaces functions and re-creates its index and trigger.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609271900_reference_data_import.sql" >/dev/null
# Shipment execution consists of replaceable RPCs and recreated protection/audit triggers.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272100_shipment_execution.sql" >/dev/null
# Tasks and notifications: columns, policies, triggers and functions are re-created.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272200_shipment_tasks_notifications.sql" >/dev/null
# The security hardening replaces policies and functions of 1600 and 2200 re-applied above.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272300_database_security_hardening.sql" >/dev/null
# Receiving is applied after hardening so its explicitly granted RPC remains available.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272400_shipment_transport_receiving.sql" >/dev/null
# Date corrections replace the protection trigger of 2100 re-applied above and are granted after 2300.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277300_shipment_date_corrections.sql" >/dev/null
# Customer orders and FEFO reservations are safe to re-apply before their tests.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272500_customer_orders_fefo.sql" >/dev/null
# Sticker layouts, print orders and marking orders are idempotent and re-applied before tests.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272600_stickers_marking.sql" >/dev/null
# Finance and costing are idempotent and re-applied before tests.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272700_finance_costing.sql" >/dev/null
# Integration registry and replaceable RPCs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272800_integration_registry.sql" >/dev/null
# Operational analytics adds an idempotent permission grant.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609272900_operational_analytics.sql" >/dev/null
# Sales forecasts recreate versioned tables, policies and controlled workflow RPCs.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273000_sales_forecasts.sql" >/dev/null
# Purchase plans and their controlled shipment creation are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273100_purchase_plans.sql" >/dev/null
# Promotions, special orders and low-shelf-life programs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273200_commercial_programs.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273300_external_client_portal.sql" >/dev/null
# Unified calendar and its replaceable RPCs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273400_shipment_calendar.sql" >/dev/null
# Document generation provenance and its registration RPC are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273500_document_generation.sql" >/dev/null
# Source extraction, review and XLSX output support are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273600_source_document_extraction.sql" >/dev/null
# Export package registration adds output-format provenance and a replaceable guarded RPC.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273700_export_document_package.sql" >/dev/null
# Warehouse operation documents and their posting/reversal RPCs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273800_inventory_operation_documents.sql" >/dev/null
# Restocking depleted batches: trigger, write-off and the repair are idempotent; grants follow the hardening.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277800_depleted_batch_restock.sql" >/dev/null
# Write-off and transfer only through a warehouse document: closes the direct RPCs granted by 2300 and 7800 above
# and replaces the line RPC of 3800.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278400_inventory_direct_operations.sql" >/dev/null
# Supplier assortment and its integrity triggers are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609273900_product_supplier_catalog.sql" >/dev/null
# Import customs-stage recovery is a repeatable data correction.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274000_import_customs_stages.sql" >/dev/null
# Purchase price visibility is permission-based and safe to re-apply.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274100_purchase_price_access.sql" >/dev/null
# Quantities from source documents: the hardening re-applied above resets function grants; idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277200_document_quantities.sql" >/dev/null
# The final portal hardening restores combined employee/client policies and pinned files.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274200_external_document_security.sql" >/dev/null
# Master-calculator storage and its guarded import/RPCs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274300_calculator_master_data.sql" >/dev/null
# Expense cancellation replaces the costing functions of 2700 and 4100 re-applied above.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278000_expense_cancel_costing.sql" >/dev/null
# The purchase price at the rate of the day the goods came replaces the calculation of 8000 above.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278700_purchase_rate_date.sql" >/dev/null
# Froosh/Fazer catalogue cleanup is a repeatable, non-destructive data correction.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274400_froosh_fazer_supplier_cleanup.sql" >/dev/null
# Calculator barcode reconciliation only replaces guarded functions.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274500_calculator_identifier_reconciliation.sql" >/dev/null
# Reviewed extraction values are validated and applied only through a guarded RPC.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274600_source_document_review.sql" >/dev/null
# Export documents are registered as XLSX only; the guarded package RPC is replaceable (must stay after 3700).
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274700_export_documents_xlsx.sql" >/dev/null
# Party requisites for the export documents only extend the review allow-list.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274800_source_document_requisites.sql" >/dev/null
# OCR for scanned source documents: permission, columns and replaceable job RPCs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609274900_source_document_ocr.sql" >/dev/null
# Reviewers may explicitly withdraw a wrong OCR confirmation and start a clean proposal.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275000_reopen_confirmed_ocr.sql" >/dev/null
# Several vehicles per shipment: columns, replaceable RPCs and the review function are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275100_multi_vehicle_shipments.sql" >/dev/null
# Received shipment items: replaces the item RPCs of 2100 and 4100 re-applied above; grants follow the hardening.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277700_received_shipment_items.sql" >/dev/null
# Assistant permissions, limits and traces: settings and grants are kept; functions are replaceable.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275200_agent_web_mvp.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275300_agent_telegram.sql" >/dev/null
# Telegram reliability: replaces the status function of 5300 and the accounting allow-lists; idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275400_telegram_reliability.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275500_agent_catalog.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275600_agent_archivist.sql" >/dev/null
# Receivables: tables, the sales trigger and RPCs are idempotent; grants are reset by the hardening re-applied above.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277600_receivables.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275700_calculator_purchase_prices.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275800_agent_drive_archive.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609275900_drive_catalog.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276000_drive_catalog_safeupdate.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276100_drive_catalog_ocr.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276200_drive_archive_access.sql" >/dev/null
# Customer returns: grants are reset by the hardening re-applied above; tables and functions are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277500_customer_returns.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276300_telegram_delivery_authorization.sql" >/dev/null
# Logist proposals: grants are reset by the hardening re-applied above; tables and functions are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277400_logist_assistant.sql" >/dev/null
# Document check agent: its state table, rules and RPCs are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276400_document_check_agent.sql" >/dev/null
# Shelf life control agent: replaceable read-only rules and the daily summary RPC are idempotent.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276500_shelf_life_control_agent.sql" >/dev/null
# Shipment number allocation replaces the existing guarded RPC and retains its grants.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276800_shipment_number_generation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276600_customer_order_fulfillment.sql" >/dev/null
# The list of shipping blockers is granted again after the hardening (2300) re-applied above revoked it.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278900_order_shipping_blockers.sql" >/dev/null
# Order notifications and rescheduling replace the list function of 8900 and add the notification type after 2200.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279000_order_blocker_notifications.sql" >/dev/null
# Shipment closing: permission, trigger, reopen RPC and the one-time repair are repeatable.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609276650_shipment_closing.sql" >/dev/null
# The operational summary is granted again after the hardening (2300) re-applied above revoked it.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278600_operational_summary.sql" >/dev/null
# Unit conversion replaces the reservation RPCs of 2500 and the fulfillment of 6600 re-applied above; it must follow them.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277100_uom_conversion.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609277900_reviewed_batch_integrity.sql" >/dev/null
# The Kazakhstan business day is a setting of every function that reads current_date: re-applying older migrations
# above re-creates those functions without it, so this one must follow them (8100 below reads no current_date).
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278300_kazakhstan_business_date.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278100_order_recovery_business_date.sql" >/dev/null
# The transport status rule replaces the function of 2100, 2300 and 8100 re-applied above.
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609278200_transport_status_after_receipt.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279100_reviewed_customs_costing.sql"

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279200_source_evidence_integrity.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279300_confirmed_invoice_evidence_refresh.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279400_customs_evidence_review.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279600_receivables_import_safety.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279500_reservation_replacement.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279700_customs_review_validation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279800_opening_import_revisions.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202609279900_customs_evidence_revision.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610190100_shipment_drive_folders.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610200100_drive_folder_reconciliation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610200200_document_transport_context.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610200300_document_processing_reliability.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610200400_integrated_document_operations.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610200500_purchase_cost_quantity.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610210200_historical_preparation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610210300_quantity_provenance.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610230100_assistant_operations.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610230200_assistant_order_fulfillment.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610230300_assistant_order_creation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610230400_assistant_reservation_review.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610230500_assistant_order_confirmation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240100_assistant_receiving.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240200_assistant_returns.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240300_assistant_return_decisions.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240400_assistant_return_cancellation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240500_assistant_expenses.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240600_assistant_expense_confirmation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240700_assistant_expense_allocation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240800_assistant_cost_calculation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610240900_assistant_cost_approval.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610241000_assistant_expense_cancellation.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610241100_assistant_expense_reversal.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610241200_assistant_expense_payment.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610250100_assistant_confirmation_deadline.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610250200_assistant_document_access.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610270100_operational_archive.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202610280100_transport_gross_customs_review.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202611010100_multi_batch_receiving.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202611010200_admin_historical_sales.sql" >/dev/null
"${PSQL[@]}" -f "$ROOT/supabase/migrations/202611020100_historical_actual_receipt.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202611030100_customs_line_matches.sql" >/dev/null

"${PSQL[@]}" -f "$ROOT/supabase/migrations/202611050100_exact_expense_allocation.sql" >/dev/null

for test_file in "$ROOT"/supabase/tests/*.test.sql; do
  echo "test: $(basename "$test_file")"
  "${PSQL[@]}" -v repo_root="$ROOT" -o /dev/null -f "$test_file"
done

echo "test: confirmed-order reservation replacement under concurrency"
node "$ROOT/scripts/test-reservation-replacement-concurrency.mjs" "${PSQL[@]}"
echo "test: cost calculation and approval under concurrent source edits"
node "$ROOT/scripts/test-cost-concurrency.mjs" "${PSQL[@]}"

echo "test: current document evidence under concurrent source edits"
node "$ROOT/scripts/test-source-integrity-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-ocr-recovery-concurrency.mjs" "${PSQL[@]}"

echo "test: order fulfillment under concurrency (duplicates and cancellation)"
node "$ROOT/scripts/test-historical-sales-concurrency.mjs" "${PSQL[@]}"
"${PSQL[@]}" -f "$ROOT/supabase/tests/fixtures/order_fulfillment.sql" >/dev/null
fulfill_pids=()
for i in $(seq 1 10); do
  "${PSQL[@]}" -tA -c "set role authenticated; select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false); select public.fulfill_customer_order(id) from tests.fulfillment_context where k='sale';" \
    >"$WORKDIR/fulfill_$i.out" 2>&1 &
  fulfill_pids+=("$!")
done
for pid in "${fulfill_pids[@]}"; do
  if ! wait "$pid"; then cat "$WORKDIR"/fulfill_*.out; exit 1; fi
done
"${PSQL[@]}" -tA -c "set role authenticated; select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false); select public.fulfill_customer_order(id) from tests.fulfillment_context where k='other';" >"$WORKDIR/ship_race.out" 2>&1 &
ship_pid=$!
"${PSQL[@]}" -tA -c "set role authenticated; select set_config('request.jwt.claim.sub','ef000000-0000-4000-8000-000000000001',false); select public.cancel_customer_order(id,'Synthetic race') from tests.fulfillment_context where k='other';" >"$WORKDIR/cancel_race.out" 2>&1 &
cancel_pid=$!
ship_ok=0; cancel_ok=0
if wait "$ship_pid"; then ship_ok=1; fi
if wait "$cancel_pid"; then cancel_ok=1; fi
if [[ $((ship_ok + cancel_ok)) != 1 ]]; then cat "$WORKDIR/ship_race.out" "$WORKDIR/cancel_race.out"; exit 1; fi
"${PSQL[@]}" -f "$ROOT/supabase/tests/order_fulfillment_concurrency_check.sql" >/dev/null

# Parallel server calls for one employee must not exceed the daily assistant limit (accounting RPCs
# are executable only by service_role, the Nexus server key): the reservation
# locks the user's day row, so exactly daily_request_limit of 30 concurrent requests succeed.
echo "test: agent daily limit under concurrency"
"${PSQL[@]}" -f "$ROOT/supabase/tests/agent_concurrency_setup.sql" >/dev/null
for i in $(seq 1 30); do
  "${PSQL[@]}" -tA -c "set role service_role; select 'run:'||run_id from public.agent_reserve_run('ac000000-0000-4000-8000-000000000001','web',null,1000);" \
    >"$WORKDIR/agent_$i.out" 2>&1 &
done
wait
granted=$(cat "$WORKDIR"/agent_*.out | grep -cE '^run:[0-9a-f-]{36}$' || true)
limited=$(cat "$WORKDIR"/agent_*.out | grep -c 'AGENT_DAILY_LIMIT' || true)
"${PSQL[@]}" -v ON_ERROR_STOP=1 -v granted="$granted" -v limited="$limited" -f "$ROOT/supabase/tests/agent_concurrency_check.sql" >/dev/null
echo "test: agent monthly budget under concurrency"
# The monthly budget is reserved under a row lock as well: with room for exactly 7 more reservations,
# 7 of 30 parallel requests succeed and the rest are refused by the budget.
"${PSQL[@]}" -f "$ROOT/supabase/tests/agent_concurrency_budget_setup.sql" >/dev/null
for i in $(seq 1 30); do
  "${PSQL[@]}" -tA -c "set role service_role; select 'run:'||run_id from public.agent_reserve_run('ac000000-0000-4000-8000-000000000001','web',null,1000);" \
    >"$WORKDIR/budget_$i.out" 2>&1 &
done
wait
granted=$(cat "$WORKDIR"/budget_*.out | grep -cE '^run:[0-9a-f-]{36}$' || true)
limited=$(cat "$WORKDIR"/budget_*.out | grep -c 'AGENT_MONTHLY_BUDGET' || true)
"${PSQL[@]}" -v ON_ERROR_STOP=1 -v granted="$granted" -v limited="$limited" -f "$ROOT/supabase/tests/agent_concurrency_budget_check.sql" >/dev/null
echo "test: agent settlement of abandoned runs under concurrency"
# Abandoned runs are charged their whole reservation by the next reservation; a late finish replaces
# the estimate. Ten late finishes race with ten reservations: each run's money is counted once.
"${PSQL[@]}" -f "$ROOT/supabase/tests/agent_concurrency_settle_setup.sql" >/dev/null
for i in $(seq 1 10); do
  "${PSQL[@]}" -tA -c "set role service_role; select 'run:'||run_id from public.agent_reserve_run('ac000000-0000-4000-8000-000000000001','web',null,1000);" \
    >"$WORKDIR/settle_reserve_$i.out" 2>&1 &
  "${PSQL[@]}" -tA -c "set role service_role; select public.agent_finish_run('ac000000-0000-4000-8000-000000000001',s.run_id,s.token,'failed','AGENT_PROVIDER_ERROR',false,'openai','m',1,0,50,10,300,'[]') from tests.agent_stale s where s.n=$i; select 'fin:ok';" \
    >"$WORKDIR/settle_finish_$i.out" 2>&1 &
done
wait
reserved=$(cat "$WORKDIR"/settle_reserve_*.out | grep -cE '^run:[0-9a-f-]{36}$' || true)
finished=$(cat "$WORKDIR"/settle_finish_*.out | grep -cE '^fin:ok$' || true)
"${PSQL[@]}" -v ON_ERROR_STOP=1 -v finished="$finished" -v reserved="$reserved" -f "$ROOT/supabase/tests/agent_concurrency_settle_check.sql" >/dev/null

echo "test: Telegram update claimed once under concurrency"
# Two workers or a redelivery may hand the same update to Nexus at the same time: exactly one claim.
for i in $(seq 1 10); do
  "${PSQL[@]}" -tA -c "set role service_role; select 'claim:'||coalesce(public.telegram_claim_update(990001,880001),'none');" \
    >"$WORKDIR/claim_$i.out" 2>&1 &
done
wait
claimed=$(cat "$WORKDIR"/claim_*.out | grep -cE '^claim:[0-9a-f]{64}$' || true)
refused=$(cat "$WORKDIR"/claim_*.out | grep -c '^claim:none$' || true)
if [[ "$claimed" != "1" || "$refused" != "9" ]]; then
  echo "Telegram update claimed $claimed times, refused $refused times; expected 1 and 9" >&2
  exit 1
fi

echo "test: shipment numbers under concurrency"
"${PSQL[@]}" -f "$ROOT/supabase/tests/shipment_number_concurrency_setup.sql" >/dev/null
shipment_jobs=()
for i in $(seq 1 30); do
  "${PSQL[@]}" -tA -f "$ROOT/supabase/tests/shipment_number_concurrency_call.sql" \
    >"$WORKDIR/shipment_$i.out" 2>&1 &
  shipment_jobs+=("$!")
done
for job in "${shipment_jobs[@]}"; do
  if ! wait "$job"; then
    cat "$WORKDIR"/shipment_*.out >&2
    exit 1
  fi
done
"${PSQL[@]}" -f "$ROOT/supabase/tests/shipment_number_concurrency_check.sql" >/dev/null

echo "database tests passed"
node "$ROOT/scripts/test-assistant-operation-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-receivables-import-concurrency.mjs" "${PSQL[@]}"

node "$ROOT/scripts/test-shipment-drive-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-receiving-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-returns-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-decisions-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-cancellation-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-expenses-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-expense-confirmation-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-allocation-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-cost-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-cost-approval-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-expense-cancellation-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-expense-reversal-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-expense-payment-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-assistant-document-access-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-customs-match-concurrency.mjs" "${PSQL[@]}"
node "$ROOT/scripts/test-exact-allocation-concurrency.mjs" "${PSQL[@]}"
