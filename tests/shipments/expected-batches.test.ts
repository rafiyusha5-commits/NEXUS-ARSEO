import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchPick, type PickList } from "../../src/lib/scan/operations.ts";
import { packingLots, receivingRows, unboundAfterReceipt, type ExpectedBatch, type ShipmentExpected } from "../../src/lib/shipments/expected-batches.ts";

const lot = (value: string, extra: Record<string, unknown> = {}) => ({ lot: value, description: "HAZELNUT KERNELS 13-15", quantity: null, cartons: null, pallets: null,
  grossKg: null, netKg: null, expiry: null, ...extra });
const source = (kind: "packing" | "invoice" | "certificate", items: unknown[], status = "confirmed", title = `Документ ${kind}`) =>
  ({ status, document: { title }, extracted_data: { supplier_lots: { kind, items, warnings: [] } } });

describe("batches of the recognized packing list", () => {
  it("merge the same lot across documents: quantity from the packing list, expiry from a certificate, labels by pallets", () => {
    const lots = packingLots([
      source("invoice", [lot("2611-01-07", { quantity: 999 })]),
      source("packing", [lot("2611-01-07", { quantity: 1200, pallets: 6, cartons: 120 }), lot("2611-01-08", { quantity: 800, cartons: 80 })]),
      source("certificate", [lot("2611-01-07", { expiry: "2027-11-30" })]),
      source("packing", [lot("2611-01-09", { quantity: 5 })], "superseded"),
      { status: "confirmed", document: null, extracted_data: { invoice_items: [] } },
    ], []);
    assert.deepEqual(lots, [
      { lot: "2611-01-07", description: "HAZELNUT KERNELS 13-15", quantity: 1200, expiry: "2027-11-30", packages: 6, documents: ["Документ invoice", "Документ packing", "Документ certificate"] },
      { lot: "2611-01-08", description: "HAZELNUT KERNELS 13-15", quantity: 800, expiry: null, packages: 80, documents: ["Документ packing"] },
    ]);
  });

  it("leave out the lots already added to the shipment, in any letters", () => {
    assert.deepEqual(packingLots([source("packing", [lot("LOT-a"), lot("LOT-B")])], [" lot-A "]).map(item => item.lot), ["LOT-B"]);
  });
});

const batch = (value: string, extra: Partial<ExpectedBatch> = {}): ExpectedBatch => ({ id: value, batch: value, expiry_date: "2027-11-30", manufacture_date: null,
  quantity: null, packages: null, source: "packing_list", source_note: null, state: "expected", note: null, batch_id: null, label_code: `NX-${value}`, printed: true, ...extra });

describe("receiving rows filled in advance", () => {
  it("one row per batch still expected; a single batch without a quantity takes the whole item", () => {
    assert.deepEqual(receivingRows(100, [batch("A")]), [{ expected: "100", batch: "A", expiry: "2027-11-30", manufactured: "", code: "NX-A" }]);
    assert.deepEqual(receivingRows(100, [batch("A", { quantity: "60.000" }), batch("B", { quantity: null, expiry_date: null }), batch("C", { state: "cancelled" })]),
      [{ expected: "60", batch: "A", expiry: "2027-11-30", manufactured: "", code: "NX-A" }, { expected: "", batch: "B", expiry: "", manufactured: "", code: "NX-B" }]);
    assert.deepEqual(receivingRows(100, []), []);
  });

  it("after the receipt, name the labels of one truck that stayed unbound", () => {
    const data: ShipmentExpected = { shipment_id: "s", shipment_number: "NAR-1", status: "receiving", can_manage: true, orphans: [], items: [
      { item_id: "i1", product_id: "p", sku: "PRE-1", product: "Фундук", uom: "piece", quantity: "100", transport_id: "t1", transport_no: 1, transport_status: "arrived",
        received: true, batches: [batch("A", { state: "received" }), batch("B", { state: "mismatch" }), batch("Q", { state: "missing" })] },
      { item_id: "i2", product_id: "p2", sku: "PRE-2", product: "Миндаль", uom: "piece", quantity: "5", transport_id: "t2", transport_no: 2, transport_status: "planned",
        received: false, batches: [batch("Z", { state: "missing" })] }] };
    assert.deepEqual(unboundAfterReceipt(data, "t1"), ["PRE-1 B (не совпала с листом)", "PRE-1 Q (не пришла)"]);
  });
});

describe("picking with a label printed in advance", () => {
  it("a batch not received under its label is not reserved: the reserved one is named", () => {
    const list: PickList = { sale_id: "s", sale_number: "ЗК-1", status: "confirmed", customer: null, can_replace: false, lines: [
      { reservation_id: "r", sku: "PRE-1", product: "Фундук", product_id: "p", batch_id: "b", batch: "LOT-A", expiry_date: null, location_id: null, location: "A-1",
        uom: "piece", quantity: "5", picked: "0" }] };
    assert.deepEqual(matchPick(list, { kind: "expected", code: "NX-1", expected: { id: "e", state: "mismatch", batch: "LOT-B", expiry_date: null, quantity: null,
      note: null, product_id: "p", sku: "PRE-1", product: "Фундук", shipment: null, transport_no: null } }), { kind: "foreign", batch: "LOT-B", expected: list.lines[0] });
  });
});
