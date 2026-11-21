#!/usr/bin/env bash
# Reference schema fingerprint (audit 2026-11-11, K3): applies every migration once, in name order, to a throwaway
# local PostgreSQL with supabase/tests/supabase_stub.sql — the order a production database should have received them —
# and prints the output of scripts/schema-fingerprint.sql. Compare it with the fingerprint of a real database:
#
#   bash scripts/schema-reference.sh > reference.tsv
#   UNTIL=202611190200_calculator_price_blocks.sql bash scripts/schema-reference.sh > reference.tsv  # stop after it
#   node --disable-warning=ExperimentalWarning scripts/schema-diff.mts reference.tsv production.tsv
#
# Unlike scripts/test-db.sh it runs no tests and re-applies nothing. Requires PostgreSQL 15+ (initdb, pg_ctl, psql).
set -euo pipefail

ROOT="${NEXUS_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PGBIN="${PGBIN:-$(pg_config --bindir 2>/dev/null || true)}"
if [[ -z "$PGBIN" || ! -x "$PGBIN/initdb" ]]; then
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
fi
if [[ -z "$PGBIN" || ! -x "$PGBIN/initdb" && ! -x "$PGBIN/initdb.exe" ]]; then
  echo "PostgreSQL server binaries not found. Set PGBIN to the directory with initdb." >&2
  exit 2
fi
UNTIL="${UNTIL:-}"
if [[ -n "$UNTIL" && ! -f "$ROOT/supabase/migrations/$UNTIL" ]]; then
  echo "No migration $UNTIL" >&2
  exit 2
fi

WORKDIR="$(mktemp -d)"
PORT="${PGPORT_TEST:-55449}"
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

# LOCALE_ARGS / LISTEN_ARGS can be overridden where C.UTF-8 or unix sockets are unavailable (Windows: ICU locale, TCP).
read -r -a locale_args <<< "${LOCALE_ARGS:---locale=C.UTF-8}"
"${RUN[@]}" "$PGBIN/initdb" -D "$WORKDIR/data" -A trust -U postgres --encoding=UTF8 "${locale_args[@]}" >/dev/null
"${RUN[@]}" "$PGBIN/pg_ctl" -D "$WORKDIR/data" -l "$WORKDIR/server.log" \
  -o "${LISTEN_ARGS:--k $WORKDIR -p $PORT -c listen_addresses=''}" -w start >/dev/null

export PGOPTIONS="-c client_min_messages=warning -c timezone=Asia/Almaty"
PSQL=(psql -h "${PGHOST_TEST:-$WORKDIR}" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)

"${PSQL[@]}" -o /dev/null -f "$ROOT/supabase/tests/supabase_stub.sql"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  "${PSQL[@]}" -o /dev/null -f "$migration"
  [[ -n "$UNTIL" && "$(basename "$migration")" == "$UNTIL" ]] && break
done
"${PSQL[@]}" -At -F $'\t' -f "$ROOT/scripts/schema-fingerprint.sql"
