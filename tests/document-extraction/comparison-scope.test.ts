import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonItems, comparisonSources, comparisonTransport } from "../../src/lib/document-extraction/comparison-scope.ts";
import { compareCommodities, type CommodityLine } from "../../src/lib/document-extraction/commodity-evidence.ts";
import { conflictsAcrossDocuments } from "../../src/lib/document-extraction/rules.ts";

test("a truck declaration compares only its own same-SKU quantities, including split positions", () => {
  const line: CommodityLine = { number: 1, description: "Synthetic", sku: "X", hsCode: "1704906500", unit: "PCS", quantity: 10, amount: 20, grossKg: null, netKg: null, customsValue: null, warnings: [] };
  const item = (shipment_transport_id: string | null, quantity: number) => ({ shipment_transport_id, sku: "X", hsCode: "1704906500", unit: "PCS", ordered: quantity, confirmed: quantity, shipped: quantity });
  const items = [item("one", 100), item("two", 4), item("two", 6), item(null, 50), item("cancelled", 30)];
  const invoice = { number: "I-2", currency: "EUR", total: 20, items: [line], warnings: [] };
  const scoped = comparisonItems(items, "two", ["one", "two"]);
  assert.equal(scoped.length, 2);
  assert.equal(compareCommodities([line], "EUR", [invoice], scoped)[0].status, "matched");
  assert.equal(compareCommodities([line], "EUR", [invoice], items)[0].status, "different");
  assert.equal(comparisonItems(items, null, ["one", "two"]).length, 4);
  assert.deepEqual(comparisonItems(items, "cancelled", ["one", "two"]), []);
});

test("another truck's invoice is excluded even with the same number; a shared source retains exact-reference validation", () => {
  const sources = [{ shipment_transport_id: "one", number: "I" }, { shipment_transport_id: "two", number: "I" }, { shipment_transport_id: null, number: "Shared" }];
  assert.deepEqual(comparisonSources(sources, "two"), sources.slice(1));
  assert.equal(comparisonSources(sources, null).length, 3);
});

test("review context wins; only a single active upload link can initialise a context", () => {
  assert.equal(comparisonTransport({ shipment_transport_id: "two" }, ["one"], ["one", "two"]), "two");
  assert.equal(comparisonTransport({ shipment_transport_id: null }, ["one"], ["one", "two"]), null);
  assert.equal(comparisonTransport(undefined, ["two", "two", "cancelled"], ["one", "two"]), "two");
  assert.equal(comparisonTransport(undefined, ["one", "two"], ["one", "two"]), null);
  assert.equal(comparisonTransport(undefined, ["cancelled"], ["one", "two"]), null);
});

test("different-truck invoice numbers and weights are not contradictions, while same-truck and shared mismatches remain", () => {
  const doc = (documentId: string, transportId: string | null, weight: number, invoice: string, contract = "C") => ({ documentId, transportId, result: { data: { gross_weight_kg: weight, invoice_number: invoice, contract_number: contract }, evidence: {}, conflicts: [] } });
  assert.deepEqual(conflictsAcrossDocuments([doc("d1", "one", 100, "I1"), doc("d2", "two", 200, "I2")]), []);
  const conflicts = conflictsAcrossDocuments([doc("d1", "one", 100, "I1"), doc("d2", "two", 200, "I2"), doc("d3", "two", 201, "I2")]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].field, "gross_weight_kg");
  assert.deepEqual(conflicts[0].documents, ["d2", "d3"]);
  assert.equal(conflictsAcrossDocuments([doc("a", null, 10, "I"), doc("b", null, 20, "I")]).length, 1);
  assert.equal(conflictsAcrossDocuments([doc("a", "one", 10, "I", "C1"), doc("b", "two", 20, "II", "C2")])[0].field, "contract_number");
});
