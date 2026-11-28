import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { REPORTS, REPORT_RPCS, REPORT_TOOLS, flattenReport } from "../../src/lib/agent/report-tools.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { channelAllowsTool } from "../../src/lib/agent/channels.ts";
import type { AgentDataSource } from "../../src/lib/agent/types.ts";

const PRODUCT = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const tool = REPORT_TOOLS[0];
const priceList = {
  date: "2026-11-21",
  types: [{ id: "33333333-3333-4333-8333-333333333333", code: "kz_prepayment", name: "Предоплата", currency: "KZT" }],
  products: [
    { id: PRODUCT, sku: "FZ-1", name: "Шоколад", brand: "Fazer", brand_known: true, prices: { kz_prepayment: { price: "1200", origin: "calculator", valid_from: "2026-11-20" } } },
    { id: "44444444-4444-4444-8444-444444444444", sku: "MB-2", name: "Печенье", brand: "Merba", brand_known: false, prices: {}, storage_path: "documents/secret.pdf", access_token: "t0k3n" },
  ],
};
function data(value: unknown, calls: { rpc: string; args: Record<string, unknown> }[] = []): AgentDataSource {
  return { async readReport(rpc: string, args: Record<string, unknown>) { calls.push({ rpc, args }); return value; } } as unknown as AgentDataSource;
}
const ctx = (source: AgentDataSource) => ({ userId: CUSTOMER, signal: new AbortController().signal, data: source });

describe("assistant reports (get_report)", () => {
  it("is a registered tool, available in Telegram, with a fixed list of report functions", () => {
    assert.equal(TOOL_BY_NAME.get("get_report"), tool);
    assert.ok(channelAllowsTool("telegram", "get_report"));
    assert.equal(REPORT_RPCS.size, REPORTS.length);
    for (const report of REPORTS) assert.ok(report.permissions.length || report.anyPermissions.length, `${report.key} needs a permission`);
    assert.deepEqual(tool.scope?.sections.map(section => section.key), REPORTS.map(report => report.key));
  });

  it("guards money reports with the same permissions as their screens", () => {
    const of = (key: string) => REPORTS.find(report => report.key === key)!;
    assert.deepEqual(of("batch_margins").permissions, ["prices.purchase.view", "inventory.view"]);
    assert.deepEqual(of("profitability").permissions, ["prices.purchase.view", "reports.view"]);
    assert.deepEqual(of("receivables").permissions, ["receivables.view"]);
    assert.deepEqual(of("payables").permissions, ["finance.view"]);
  });

  it("reports losses with their screen rights and passes the group as a fixed argument", async () => {
    const of = (key: string) => REPORTS.find(report => report.key === key)!;
    assert.deepEqual(of("losses").permissions, ["reports.view", "inventory.view"]);
    assert.deepEqual(of("loss_risk").permissions, ["reports.view", "inventory.view"]);
    const calls: { rpc: string; args: Record<string, unknown> }[] = [];
    await tool.run(ctx(data({ rows: [] }, calls)), { report: "losses", group: "reason", date: "2026-11-01", date_to: "2026-11-28" });
    await tool.run(ctx(data({ rows: [] }, calls)), { report: "loss_risk" });
    assert.deepEqual(calls, [
      { rpc: "loss_report", args: { p_group: "reason", p_from: "2026-11-01", p_to: "2026-11-28" } },
      { rpc: "loss_risk", args: { p_group: "bucket" } },
    ]);
  });

  it("flattens a report into rows, keeps identifiers as references and drops secrets", () => {
    const rows = flattenReport(priceList);
    assert.deepEqual(rows.map(row => row.part), ["итог", "types", "products", "products"]);
    assert.equal(rows[2].references.id, PRODUCT);
    const text = JSON.stringify(rows);
    assert.ok(!text.includes("secret.pdf") && !text.includes("t0k3n"));
  });

  it("returns filtered rows of the report and the summary, with paging", async () => {
    const calls: { rpc: string; args: Record<string, unknown> }[] = [];
    const result = await tool.run(ctx(data(priceList, calls)), { report: "price_list", query: "fazer" });
    assert.deepEqual(calls, [{ rpc: "price_list", args: { p_date: null } }]);
    assert.equal(result.rows.length, 2);
    assert.match(String(result.rows[1].values.record_details), /sku: FZ-1[\s\S]*prices: kz_prepayment: price: 1200/);
    assert.ok(!JSON.stringify(result).includes("Печенье"));
    const page = await tool.run(ctx(data(priceList)), { report: "price_list", limit: 1, offset: 1 });
    assert.equal(page.rows.length, 1);
    assert.equal(page.truncated, true);
  });

  it("asks for a missing identifier instead of calling the function", async () => {
    const calls: { rpc: string; args: Record<string, unknown> }[] = [];
    const result = await tool.run(ctx(data({}, calls)), { report: "customer_statement" });
    assert.equal(calls.length, 0);
    assert.match(result.notes[0], /нужно: customer_id/);
    const statement = await tool.run(ctx(data({ rows: [] }, calls)), { report: "customer_statement", customer_id: CUSTOMER });
    assert.deepEqual(calls[0], { rpc: "customer_statement", args: { p_customer_id: CUSTOMER } });
    assert.equal(statement.rows.length, 0);
  });

  it("reads the journal of inventory counts with the rights of their screens, nothing to change", async () => {
    const calls: { rpc: string; args: Record<string, unknown> }[] = [];
    await tool.run(ctx(data({ counts: [{ number: "ИНВ-000001", status: "review", warehouse: "Алматы" }] }, calls)), { report: "inventory_counts" });
    assert.deepEqual(calls[0], { rpc: "inventory_count_list", args: { p_limit: 100 } });
    const of = (key: string) => REPORTS.find(report => report.key === key)!;
    assert.deepEqual(of("inventory_counts").anyPermissions, ["inventory.view", "inventory.count.manage", "inventory.count.record", "inventory.count.approve"]);
  });

  it("passes the period and group of profitability as fixed argument names", async () => {
    const calls: { rpc: string; args: Record<string, unknown> }[] = [];
    await tool.run(ctx(data({ groups: [] }, calls)), { report: "profitability", group: "customer", date: "2026-11-01", date_to: "2026-11-21" });
    assert.deepEqual(calls[0], { rpc: "profitability_report", args: { p_group: "customer", p_from: "2026-11-01", p_to: "2026-11-21" } });
  });
});
