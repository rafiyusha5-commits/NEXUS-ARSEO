import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { createSupabaseAgentData } from "../../src/lib/agent/server/supabase-data.ts";

const urls: URL[] = [];
const rows = [{ id: "a", created_at: "2026-10-01", planned_ready_date: "2026-10-15", planned_arrival_date: "2026-10-25" }, { id: "b", created_at: "2026-10-02", planned_ready_date: "2026-10-14" }];
const fetcher = (async (url: string | URL | Request) => {
  const parsed = new URL(String(url)); urls.push(parsed);
  const loading = parsed.searchParams.has("transports.planned_loading_date");
  const values = loading ? rows : [rows[0]];
  return Response.json(values, { headers: { "Content-Range": `0-${values.length - 1}/${values.length}` } });
}) as typeof fetch;
const supabase = createClient("https://demo.supabase.co", "public-demo", { global: { fetch: fetcher }, auth: { persistSession: false, autoRefreshToken: false } });
const source = createSupabaseAgentData(supabase);
const result = await source.findShipments({ date: "2026-10-15", dateKind: "any", limit: 10 }, new AbortController().signal);
assert.equal(result.total, 2);
assert.equal(result.rows.length, 2);
assert.equal(result.rows[0].id, "b", "newer shipment remains first after combining date searches");
assert.equal(result.rows[1].matched_date_kind, "Готовность, Загрузка машины");
assert.ok(urls.some(url => url.searchParams.get("transports.planned_loading_date") === "eq.2026-10-15"));
assert.ok(urls.some(url => url.searchParams.get("or") === "(planned_ready_date.eq.2026-10-15,planned_arrival_date.eq.2026-10-15)"));
urls.length = 0;
await source.findShipments({ query: "NAR", date: "2026-10-15", dateKind: "any", limit: 10 }, new AbortController().signal);
assert.ok(urls.some(url => url.searchParams.get("or")?.includes("and(or(shipment_number.ilike.%NAR%")), "text and date predicates must both remain active");
assert.ok(urls.every(url => !url.searchParams.get("select")?.includes("driver") && !url.searchParams.get("select")?.includes("price")));
console.log("Date search server checks passed");
