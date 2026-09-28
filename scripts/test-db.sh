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

"${RUN[@]}" "$PGBIN/initdb" -D "$WORKDIR/data" -A trust -U postgres >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORKDIR/data" -l "$WORKDIR/server.log" \
  -o "-k $WORKDIR -p $PORT -c listen_addresses=''" -w start >/dev/null

export PGOPTIONS="-c client_min_messages=warning"
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

for test_file in "$ROOT"/supabase/tests/*.test.sql; do
  echo "test: $(basename "$test_file")"
  "${PSQL[@]}" -v repo_root="$ROOT" -o /dev/null -f "$test_file"
done

echo "database tests passed"
