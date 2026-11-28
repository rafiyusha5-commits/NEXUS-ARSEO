import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { incompleteText, lossLineRows, monthLabel, parseLossParams, percent, riskItemRows, rowName } from "../../src/lib/analytics/losses.ts";
import { createXlsx } from "../../src/lib/xlsx.ts";

describe("losses report (202611280100)", () => {
  it("defaults to losses of the current month by reason and never inverts the period", () => {
    assert.deepEqual(parseLossParams({}, "2026-11-28"), { view: "period", group: "reason", risk: "bucket", from: "2026-11-01", to: "2026-11-28" });
    assert.deepEqual(parseLossParams({ view: "risk", risk: "supplier", from: "2026-11-20", to: "2026-11-02" }, "2026-11-28"),
      { view: "risk", group: "reason", risk: "supplier", from: "2026-11-02", to: "2026-11-20" });
    const unknown = parseLossParams({ view: "drop", group: "customer; --", risk: "x", from: "yesterday" }, "2026-11-28");
    assert.equal(unknown.view, "period");
    assert.equal(unknown.group, "reason");
    assert.equal(unknown.risk, "bucket");
    assert.equal(unknown.from, "2026-11-01");
  });

  it("shows months as words, a missing share as a dash and what keeps a row incomplete", () => {
    assert.equal(monthLabel("2026-11"), "ноябрь 2026");
    assert.equal(monthLabel("bad"), "bad");
    assert.equal(rowName("month", { key: "2026-02", name: "2026-02" }), "февраль 2026");
    assert.equal(rowName("reason", { key: "unspecified", name: "Причина не указана" }), "Причина не указана");
    assert.equal(percent(null), "—");
    assert.equal(incompleteText({ complete: 4, no_cost: 1, no_rate: 2 }), "нет себестоимости: 1, нет курса: 2");
    assert.equal(incompleteText({ complete: 4 }), "");
  });

  it("exports lines with text as text and hidden or missing amounts as empty cells", () => {
    const rows = lossLineRows([{ line_date: "2026-11-28", source: "document", ref_number: "СПС-1", reason: "Истёк срок годности",
      warehouse: "ALA", sku: "=HYPERLINK(\"x\")", product: "Товар", batch: "0012", expiry_date: "2026-11-01", shipment: null, uom: "box",
      quantity: "2.000", pieces: "24", cost_currency: null, cost: null, rate: null, cost_kzt: null, status: "no_cost" }]);
    assert.equal(rows[0].length, rows[1].length, "every line has every column");
    assert.equal(rows[1][1], "Складской документ");
    assert.equal(rows[1][7], "0012", "a batch number stays text");
    assert.equal(rows[1][10], "кор.");
    assert.equal(rows[1][16], null, "no amount is an empty cell, not zero");
    assert.equal(rows[1][17], "нет себестоимости");
    const risk = riskItemRows([{ balance_id: "b", batch_id: "x", sku: "A-1", product: "Товар", brand: "Fazer", batch: "R1",
      expiry_date: "2026-12-10", days_left: 12, bucket: "critical", batch_status: "available", warehouse: "ALA", location: null, uom: "piece",
      quantity: "10.000", reserved: "0.000", pieces: "10", plan: "none", cost_kzt: null, status: "complete" }]);
    assert.equal(risk[1][12], "нет плана продажи");
    assert.equal(risk[1][13], null);
    assert.ok(createXlsx([{ name: "Потери", rows }, { name: "Под риском", rows: risk }]).length > 0);
  });
});
