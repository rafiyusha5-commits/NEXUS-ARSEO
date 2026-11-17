import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { incompleteText, parseProfitParams, percent, profitLineRows } from "../../src/lib/analytics/profitability.ts";
import { createXlsx } from "../../src/lib/xlsx.ts";

describe("profitability report", () => {
  it("defaults to the current month and never inverts the period", () => {
    assert.deepEqual(parseProfitParams({}, "2026-11-17"), { group: "shipment", from: "2026-11-01", to: "2026-11-17" });
    assert.deepEqual(parseProfitParams({ group: "customer", from: "2026-11-10", to: "2026-11-01" }, "2026-11-17"), { group: "customer", from: "2026-11-01", to: "2026-11-10" });
    assert.equal(parseProfitParams({ group: "drop table", from: "x" }, "2026-11-17").group, "shipment");
  });
  it("names what keeps a row incomplete and shows no margin as a dash", () => {
    assert.equal(incompleteText({ approved: 3, no_price: 1, no_rate: 2 }), "нет цены продажи: 1, нет курса: 2");
    assert.equal(incompleteText({ approved: 3 }), "");
    assert.equal(percent(null), "—");
  });
  it("exports lines with text as text and missing figures as empty cells", () => {
    const rows = profitLineRows([{ kind: "sale", date: "2026-11-17", sale_number: "SO-1", customer: "=HYPERLINK(\"x\")", product: "A-1",
      batch: "0012", shipment: null, pieces: "100.000", sale_currency: "KZT", revenue_gross: "840000.00", vat_included: true, vat_rate: "0.12",
      revenue_net: "750000.00", revenue_rate: "1", revenue_rate_date: "2026-11-17", cost_currency: "EUR", cost: null, cost_status: "none",
      cost_rate: null, revenue_net_kzt: "750000.00", revenue_gross_kzt: "840000.00", cost_kzt: null, profit_kzt: null, status: "no_cost", old_rule: false }]);
    assert.equal(rows[1][5], "0012", "a batch number stays text");
    assert.equal(rows[1][16], null, "no cost is an empty cell, not zero");
    assert.equal(rows[1][23], "нет себестоимости");
    const xml = createXlsx([{ name: "Прибыльность", rows }]).toString("latin1");
    assert.ok(xml.length > 0);
  });
});
