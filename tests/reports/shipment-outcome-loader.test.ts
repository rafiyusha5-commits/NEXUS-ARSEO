import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import { it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";

// Runtime is Node 24; the project's Node 20 declarations do not yet include synchronous hooks.
type Resolution = { url: string; shortCircuit?: boolean };
type Resolve = (specifier: string, context: unknown, next: (specifier: string, context: unknown) => Resolution) => Resolution;
const { registerHooks } = nodeModule as unknown as { registerHooks(hooks: { resolve: Resolve }): { deregister(): void } };
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (specifier === "server-only") return { url: "data:text/javascript,export {};", shortCircuit: true };
  if (specifier === "@/lib/shipment-outcome-rules") return { url: new URL("../../src/lib/shipment-outcome-rules.ts", import.meta.url).href, shortCircuit: true };
  return next(specifier, context);
} });
const { loadShipmentOutcome } = await import(new URL("../../src/lib/shipment-outcome.ts", import.meta.url).href);
hooks.deregister();

type CostRow = { version_number: number; status: string; landed_total: number };
async function chosenCost(rows: CostRow[]) {
  const supabase = { from(table: string) {
    assert.equal(table, "cost_calculations");
    const orders: Array<{ key: keyof CostRow; ascending: boolean }> = [];
    let limit = Infinity;
    const query = {
      select() { return query; }, eq() { return query; }, in() { return query; },
      order(key: keyof CostRow, options: { ascending: boolean }) { orders.push({ key, ...options }); return query; },
      limit(n: number) { limit = n; return query; },
      then(resolve: (value: { data: CostRow[] }) => unknown) {
        const sorted = [...rows].sort((a, b) => {
          for (const { key, ascending } of orders) {
            const direction = a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0;
            if (direction) return ascending ? direction : -direction;
          }
          return 0;
        });
        return Promise.resolve({ data: sorted.slice(0, limit) }).then(resolve);
      },
    };
    return query;
  } } as unknown as SupabaseClient;
  const result = await loadShipmentOutcome(supabase, "shipment", [], new Set(["costing.view", "prices.purchase.view"]));
  return result.cost;
}

it("retains the latest approved cost even behind many newer drafts", async () => {
  const cost = await chosenCost([
    { version_number: 1, status: "approved", landed_total: 100 },
    { version_number: 2, status: "approved", landed_total: 200 },
    ...Array.from({ length: 10 }, (_, i) => ({ version_number: i + 3, status: "draft", landed_total: 900 })),
  ]);
  assert.equal(cost.version, 2);
  assert.equal(cost.status, "approved");
  assert.equal(cost.landedTotal, 200);
});

it("uses the newest draft only when no approved cost exists", async () => {
  const cost = await chosenCost([
    { version_number: 1, status: "draft", landed_total: 100 },
    { version_number: 2, status: "draft", landed_total: 200 },
  ]);
  assert.equal(cost.version, 2);
  assert.equal(cost.status, "draft");
  assert.equal(await chosenCost([]), null);
});
