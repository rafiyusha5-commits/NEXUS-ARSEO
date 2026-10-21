import test from "node:test";
import assert from "node:assert/strict";
import { quantityDifferences, quantitySource, type ProvenanceItem, type QuantityEvent } from "../src/lib/shipments/quantity-provenance.ts";
const item: ProvenanceItem = { id: "i", sku: "SYN", name: { ru: "Синтетический товар" }, uom: "piece", transport: 1,
  ordered: 1000, confirmed: 965, shipped: 965, received: 960, history: [], demandHistory: [], receipts: [] };
const event: QuantityEvent = { id: "h", field: "confirmed", previous: null, quantity: 965, at: "2026-10-01T00:00:00Z", actor: "Тест", documentId: "d", document: "Синтетический инвойс", version: 1, currentVersion: true, reviewed: true, latest: true };
test("1000 / 965 / 960: demand -35 and receiving -5 remain distinct", () => {
  assert.deepEqual(quantityDifferences(item), { supplierVsDemand: -35, receiptVsShipped: -5 });
  assert.equal(item.receipts.length, 0); // neither delta fabricates a recorded shortage
});
test("missing values are not zero, receiving never falls back to order", () => {
  assert.deepEqual(quantityDifferences({ ...item, confirmed: null, shipped: null }), { supplierVsDemand: null, receiptVsShipped: null });
  assert.deepEqual(quantityDifferences({ ...item, confirmed: 0, shipped: 0, received: 0 }), { supplierVsDemand: -1000, receiptVsShipped: 0 });
});
test("vehicle splits and different units are independent; three decimal precision", () => {
  assert.equal(quantityDifferences({ ...item, uom: "box", ordered: 2.3, confirmed: 2.1 }).supplierVsDemand, -.2);
  assert.equal(quantityDifferences({ ...item, transport: 2 }).receiptVsShipped, -5);
});
test("no invented source; older matching value is not current evidence", () => {
  assert.equal(quantitySource(item, "confirmed"), null);
  assert.equal(quantitySource({ ...item, history: [event] }, "confirmed"), event);
  assert.equal(quantitySource({ ...item, history: [{ ...event, latest: false }] }, "confirmed"), null);
  assert.equal(quantitySource({ ...item, confirmed: 964, history: [event] }, "confirmed"), null);
  const historical = { ...event, currentVersion: false, reviewed: false };
  assert.equal(quantitySource({ ...item, history: [historical] }, "confirmed"), historical);
});
