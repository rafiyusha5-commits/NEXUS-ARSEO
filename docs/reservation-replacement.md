# Explicit replacement of confirmed-order reservations

Base: `0569ff0c2d81825ac024cfbed1952db0e926d976` (`origin/main`, fetched 2026-10-19).
Branch: `feat/order-reservation-replacement`. No dependency on PRs 9, 12, 13, 36, 40, 45–47.

## Behaviour

Shipping → Replace batches → select whole order lines and distribute their quantities → mandatory reason →
Check allocation → inspect the server-calculated order/stock quantities → Confirm replacement.
Merely opening the page never writes. Candidates are ordered by expiry/receipt/batch ID (FEFO).
Manual selection retains the existing `sales.override_fefo` permission; this does not grant new roles any authority.
Expiry uses the later of the planned date and the Kazakhstan business day. No movement to another warehouse.

The single transactional RPC locks the order, lines, reservations, stock balances in UUID order, batches,
products/packaging and guarantee letters. It validates coverage/conversion/free stock/eligibility, compares
the preview snapshot, releases only selected lines, inserts their replacements, and invokes existing confirmation.
Any failure rolls everything back. Unselected distributions, physical stock, prices and cost are unchanged.
The confirmation transition also retains the existing receivables guard; its potentially confidential error
amounts are not relayed to the browser. Original confirmation authorship is retained.

An immutable event keeps employee, timestamp, reason and old/new allocation. Cancelled old reservation rows
are retained. History is available after fulfillment or cancellation. A request UUID is bound to actor, order,
reason, preview and allocation: an identical retry acknowledges the same event even after shipping; reuse
with a different payload is rejected. The browser retains this payload/UUID after a transport error.

## Existing operations reused

- `private.release_sale_item_reservations`: releases quantities and retains cancelled reservation history.
- `private.convert_uom`, the reservation-unit trigger: exact conversion through product packaging, scale 3.
- `private.sale_shelf_life_pct`, `private.business_today`: current Nexus shelf-life/business-date rules.
- `public.confirm_customer_order` / `private.refresh_sale_shelf_life`: full confirmation and guarantee checks.
- Existing `fulfill_customer_order` and `cancel_customer_order`: their order lock serializes against replacement.
- Existing `return_customer_order_to_preparation`: remains the explicit fallback when a NEW guarantee is needed.
  It is intentionally NOT invoked inside replacement: it cancels all current letters, including unrelated ones.

No letter is copied or silently revoked. A low-OSG replacement needs an already approved/sent/accepted letter
matching this exact line, batch, aggregate quantity, required and current shelf life. Otherwise return to preparation
and use the established letter workflow. Old letters remain history and do not authorize another batch.

## Checks

`corepack pnpm typecheck`, `corepack pnpm lint`, `corepack pnpm test`, `corepack pnpm build`.
`corepack pnpm test:db` initializes its own PostgreSQL cluster and applies/reapplies migrations, the security
allowlist tests and regression SQL. It now invokes `scripts/test-reservation-replacement-concurrency.mjs`.

Regression SQL: boxes from pieces, one batch replaced by two, whole selected-line coverage, another line
unchanged, insufficient stock, failure after writes (full rollback), request replay/collision, personal denies,
quarantine, wrong warehouse, missing/changed packaging, stale preview, old-letter binding, history,
no physical changes and subsequent standard fulfillment. Dates are fixed in 2099, with an explicit expiry guard.

Real concurrency harness: independent psql connections; `pg_stat_activity` proves a lock wait before asserting
the outcome. Two employees on one order; duplicate request; two orders competing for the last 20 pieces;
replacement before/after fulfillment; cancellation before/after replacement; batch block before/after replacement;
personal deny committed while waiting for the order lock. Ten explicitly synchronized scenarios.
These are actual transactions, not mock promises or PGlite concurrency claims.

## Limits / handoff

- Requires migration `202609279500_reservation_replacement.sql`; prepare/apply only through owner deployment.
- Local Windows has no usable PostgreSQL16/bash cluster. Local SQL regressions use isolated in-memory
  PGlite PostgreSQL18.3; authoritative PostgreSQL16 and concurrent results are the GitHub CI database job.
- Preview fails closed above 100 lines/2000 candidate balances; no silent truncation. It does not auto-select
  quantities. Distribution is manual, with candidates sorted FEFO and server validation before confirmation.
- Snapshot is deliberately conservative: changes to another candidate's stock also require refreshing.
- Locks cover all matching stock for the order's warehouse/products; large catalogues can contend. No new index
  or broad redesign of legacy reservation RPC lock ordering is attempted. PostgreSQL aborts any detected
  legacy-operation deadlock atomically; the caller must refresh/retry.
- New stock/packaging rows committed after the snapshot may cause a conservative refresh on the next request;
  existing selected balances/batches/conversions are locked through commit.
- A batch may be blocked AFTER a successful replacement commits. This is valid serialization, not a bypass:
  normal fulfillment rechecks status and refuses to ship it.
- No live Supabase, OCR/LLM, Telegram, Google Drive/Sheets, secrets, training database or schedule was used.
- Do not merge/deploy automatically. Review the SQL access/locking strategy, existing confirmation reuse,
  guarantee restrictions, exact UOM conversion, responsive preview and CI results.
