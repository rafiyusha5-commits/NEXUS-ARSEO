import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildBatchOutcomes, countFindings, remainingShelfLifePct, summarizeOutcomes } from "../../src/lib/shipment-outcome-rules.ts";

const batch = { id: "b1", batch_number: "L-1", product_id: "p1", manufacture_date: "2026-01-01", expiry_date: "2026-12-31", status: "available", shelf_life_days: 365 };
const W1 = "w1", W2 = "w2";

describe("where the batches of a shipment went", () => {
  it("accounts for receipt, sales, write-off, transfer and adjustment, and checks the balance", () => {
    const [outcome] = buildBatchOutcomes([batch], [
      { batch_id: "b1", uom: "piece", quantity_on_hand: "60.5", quantity_reserved: 10 },
      { batch_id: "b1", uom: "piece", quantity_on_hand: 20, quantity_reserved: 0 },
    ], [
      { batch_id: "b1", movement_type: "receipt", quantity: 100, uom: "piece", from_warehouse_id: null, to_warehouse_id: W1 },
      { batch_id: "b1", movement_type: "issue", quantity: "15.5", uom: "piece", from_warehouse_id: W1, to_warehouse_id: null },
      { batch_id: "b1", movement_type: "write_off", quantity: 5, uom: "piece", from_warehouse_id: W1, to_warehouse_id: null },
      { batch_id: "b1", movement_type: "transfer", quantity: 20, uom: "piece", from_warehouse_id: W1, to_warehouse_id: W2 },
      { batch_id: "b1", movement_type: "adjustment", quantity: 1, uom: "piece", from_warehouse_id: null, to_warehouse_id: W1 },
    ], [
      { batch_id: "b1", quantity: 10, status: "active", sale: { id: "s1", sale_number: "SO-2", status: "reserved", customer_name: "Magnum" } },
      { batch_id: "b1", quantity: "15.5", status: "fulfilled", sale: { id: "s0", sale_number: "SO-1", status: "shipped", customer_name: null } },
      { batch_id: "b1", quantity: 7, status: "cancelled", sale: { id: "s9", sale_number: "SO-9", status: "cancelled", customer_name: "X" } },
    ], "2026-07-01");
    assert.deepEqual(outcome.flows, [{ uom: "piece", received: 100, issued: 15.5, writtenOff: 5, adjustedIn: 1, adjustedOut: 0, onHand: 80.5, reserved: 10, balanced: true }]);
    assert.deepEqual(outcome.customers.map(c => [c.saleNumber, c.customerName, c.reserved, c.fulfilled]), [["SO-1", null, 0, 15.5], ["SO-2", "Magnum", 10, 0]]);
  });

  it("reports a balance the movements do not explain", () => {
    const [outcome] = buildBatchOutcomes([batch], [{ batch_id: "b1", uom: "piece", quantity_on_hand: 90, quantity_reserved: 0 }],
      [{ batch_id: "b1", movement_type: "receipt", quantity: 100, uom: "piece", from_warehouse_id: null, to_warehouse_id: W1 }], [], "2026-07-01");
    assert.equal(outcome.flows[0].balanced, false);
    assert.equal(summarizeOutcomes([outcome]).balanced, false);
  });

  it("keeps units apart and sums the shipment per unit", () => {
    const second = { ...batch, id: "b2", batch_number: "L-2" };
    const outcomes = buildBatchOutcomes([batch, second], [
      { batch_id: "b1", uom: "piece", quantity_on_hand: 0.1, quantity_reserved: 0 },
      { batch_id: "b2", uom: "piece", quantity_on_hand: 0.2, quantity_reserved: 0 },
      { batch_id: "b2", uom: "box", quantity_on_hand: 3, quantity_reserved: 1 },
    ], [
      { batch_id: "b1", movement_type: "receipt", quantity: 0.1, uom: "piece", from_warehouse_id: null, to_warehouse_id: W1 },
      { batch_id: "b2", movement_type: "receipt", quantity: 0.2, uom: "piece", from_warehouse_id: null, to_warehouse_id: W1 },
      { batch_id: "b2", movement_type: "receipt", quantity: 3, uom: "box", from_warehouse_id: null, to_warehouse_id: W1 },
    ], [], "2026-07-01");
    const summary = summarizeOutcomes(outcomes);
    assert.equal(summary.balanced, true);
    assert.deepEqual(summary.units.find(unit => unit.uom === "piece"), { uom: "piece", received: 0.3, issued: 0, writtenOff: 0, onHand: 0.3, reserved: 0 });
    assert.deepEqual(summary.units.find(unit => unit.uom === "box"), { uom: "box", received: 3, issued: 0, writtenOff: 0, onHand: 3, reserved: 1 });
  });

  it("computes the remaining shelf life like the database", () => {
    assert.equal(remainingShelfLifePct(batch, "2026-07-01"), 50.27, "183 of 364 days left");
    assert.equal(remainingShelfLifePct({ ...batch, manufacture_date: null }, "2026-12-01"), 8.22, "falls back to the product shelf life");
    assert.equal(remainingShelfLifePct(batch, "2027-02-01"), 0, "expired is zero, not negative");
    assert.equal(remainingShelfLifePct({ ...batch, manufacture_date: null, shelf_life_days: null }, "2026-07-01"), null, "unknown is not invented");
  });

  it("counts document check findings", () => {
    assert.deepEqual(countFindings([{ severity: "error" }, { severity: "warning" }, { severity: "error" }]), { errors: 2, warnings: 1 });
  });
});

describe("final report sheets", () => {
  it("states hidden blocks instead of leaving them empty", async () => {
    const { outcomeWorkbookSheets } = await import("../../src/lib/shipment-outcome-workbook.ts");
    const sheets = outcomeWorkbookSheets({
      today: "2026-10-13", inventoryVisible: false, salesVisible: false, outcomes: [], products: new Map(),
      summary: { units: [], balanced: true, batches: 0 }, cost: "hidden", documentCheck: "hidden", shelfLife: "hidden",
    }, []);
    assert.deepEqual(sheets.map(sheet => sheet.name), ["Итог", "Движение партий"], "no cost or check sheets without rights");
    assert.deepEqual(sheets[1].rows, [["Нет права просматривать склад"]]);
    const values = sheets[0].rows.map(row => row[2]);
    assert.ok(values.includes("Нет доступа"), "summary says the cost, the check and shelf life are hidden");
  });

  it("lists batch flows, cost and document check findings", async () => {
    const { outcomeWorkbookSheets } = await import("../../src/lib/shipment-outcome-workbook.ts");
    const [outcome] = buildBatchOutcomes([batch], [{ batch_id: "b1", uom: "piece", quantity_on_hand: 90, quantity_reserved: 5 }],
      [{ batch_id: "b1", movement_type: "receipt", quantity: 100, uom: "piece", from_warehouse_id: null, to_warehouse_id: W1 },
       { batch_id: "b1", movement_type: "issue", quantity: 10, uom: "piece", from_warehouse_id: W1, to_warehouse_id: null }],
      [{ batch_id: "b1", quantity: 5, uom: "piece", status: "active", sale: { id: "s1", sale_number: "SO-7", status: "reserved", customer_name: "Small" } }], "2026-07-01");
    const sheets = outcomeWorkbookSheets({
      today: "2026-10-13", inventoryVisible: true, salesVisible: true, outcomes: [outcome], products: new Map([["p1", { internal_sku: "SKU-1", name: "Товар" }]]),
      summary: summarizeOutcomes([outcome]),
      cost: { version: 2, status: "approved", approvedAt: "2026-09-01T00:00:00Z", currency: "KZT", goodsTotal: 1000, expensesTotal: 200, landedTotal: 1200, items: [{ shipmentItemId: "i1", quantity: 98, costQuantity: 100, landedAmount: 1200, unitLandedCost: 12 }] },
      documentCheck: { lastRunAt: null, findings: [{ severity: "error", message: "Вес не совпадает", transport_no: 1, document_title: "CMR" }], counts: { errors: 1, warnings: 0 } },
      shelfLife: [{ batchId: "b1", state: "soon", firstDeadline: "2026-11-01" }],
    }, [{ id: "i1", uom: "piece", product: { internal_sku: "SKU-1" } }]);
    assert.deepEqual(sheets.map(sheet => sheet.name), ["Итог", "Движение партий", "Себестоимость", "Сверка"]);
    assert.deepEqual(sheets[1].rows[1].slice(0, 15), ["L-1", "SKU-1", "Товар", "2026-12-31", 50.27, "Скоро ниже требований", "piece", 100, 10, 0, 0, 0, 90, 5, "да"]);
    assert.match(String(sheets[1].rows[1][15]), /SO-7 Small: резерв 5 piece/);
    assert.deepEqual(sheets[2].rows.at(-1), ["SKU-1", "piece", 98, 100, 1200, 12]);
    assert.deepEqual(sheets[3].rows[1], ["Ошибка", 1, "Вес не совпадает", "CMR"]);
  });
});
