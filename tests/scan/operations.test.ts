import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scanHref } from "../../src/lib/scan/href.ts";
import type { ScanResult } from "../../src/lib/scan/lookup.ts";
import { matchPick, matchReceiving, nextPick, normalizeCode, pickDone, remaining, scannedBatches, type PickList } from "../../src/lib/scan/operations.ts";

const line = (n: number, product: string, batch: string, quantity: string, picked: string) => ({
  reservation_id: `r${n}`, sku: `SKU-${product}`, product: `Товар ${product}`, product_id: product, batch_id: batch, batch: `LOT-${batch}`,
  expiry_date: "2027-06-15", location_id: `l${n}`, location: `A-0${n}`, uom: "piece", quantity, picked });
const list: PickList = { sale_id: "s", sale_number: "ЗК-1", status: "confirmed", customer: null, can_replace: false,
  lines: [line(1, "p1", "b1", "10", "10"), line(2, "p2", "b2", "12.5", "2.25"), line(3, "p2", "b3", "6", "0")] };
const stockRow = (batch: string, batchId: string) => ({ balance_id: batchId, warehouse_id: "w", warehouse: "W", location_id: null, location: null, product_id: "p2",
  sku: "SKU-p2", product: "Товар p2", batch_id: batchId, batch, expiry_date: null, batch_status: "available", uom: "piece", on_hand: "1", reserved: "0", free: "1",
  unit_cost: null, cost_currency: null, cost_uom: null });
const product = (stock = [stockRow("LOT-b2", "b2"), stockRow("LOT-b3", "b3"), stockRow("LOT-b9", "b9")]): ScanResult => ({ kind: "product", code: "04601234567893",
  products: [{ product_id: "p2", sku: "SKU-p2", product: "Товар p2", identifier_type: "gtin", uom: "piece", pieces: null, batch_found: true, stock }] });
const batch = (id: string, name: string, productId = "p2"): ScanResult => ({ kind: "batch", code: "NX-7KQ2M9TA",
  batch: { id, batch: name, expiry_date: null, status: "available", product_id: productId, sku: "SKU", product: "Товар" }, stock: [] });

describe("picking", () => {
  it("counts what is left exactly to the thousandth and walks the lines in their order", () => {
    assert.equal(remaining(list.lines[1]), 10.25);
    assert.equal(nextPick(list)?.reservation_id, "r2");
    assert.equal(pickDone(list), false);
    assert.equal(pickDone({ ...list, lines: list.lines.map(item => ({ ...item, picked: item.quantity })) }), true);
    assert.equal(pickDone({ ...list, lines: [] }), false, "an order without reservations is not picked");
  });

  it("a batch label or a product code with its batch names the batch; a product code alone names none", () => {
    assert.deepEqual(scannedBatches(batch("b3", "LOT-b3")), ["b3"]);
    assert.deepEqual(scannedBatches(product(), "LOT-b2"), ["b2"]);
    assert.deepEqual(scannedBatches(product()), []);
    assert.deepEqual(scannedBatches(null), []);
  });

  it("the reserved batch is picked; a picked one is done; another batch is foreign and the reserved one is named", () => {
    assert.deepEqual(matchPick(list, batch("b3", "LOT-b3")), { kind: "pick", line: list.lines[2] });
    assert.deepEqual(matchPick(list, product(), "LOT-b2"), { kind: "pick", line: list.lines[1] });
    assert.deepEqual(matchPick(list, batch("b1", "LOT-b1", "p1")), { kind: "done", line: list.lines[0] });
    assert.deepEqual(matchPick(list, batch("b9", "LOT-b9")), { kind: "foreign", batch: "LOT-b9", expected: list.lines[1] });
    assert.deepEqual(matchPick(list, product(), "LOT-b9"), { kind: "foreign", batch: "LOT-b9", expected: list.lines[1] });
    assert.deepEqual(matchPick(list, product([]), "LOT-NEW"), { kind: "foreign", batch: "LOT-NEW", expected: list.lines[1] }, "a batch unknown to Nexus is foreign");
    assert.deepEqual(matchPick(list, product()), { kind: "need_batch", product: "Товар p2" });
    assert.deepEqual(matchPick(list, { kind: "unknown", code: "x", can_bind: false }), { kind: "not_found" });
    assert.deepEqual(matchPick(list, { kind: "location", code: "NX-1", location: { id: "l", code: "A", zone: "storage", status: "active", warehouse_id: "w", warehouse: "W" }, stock: [] }),
      { kind: "not_found" });
  });
});

describe("receiving codes", () => {
  it("a GTIN-13 and its GTIN-14 with a leading zero are the same product; other codes compare as written", () => {
    assert.equal(normalizeCode("4601234567893"), "04601234567893");
    assert.equal(normalizeCode(" 04601234567893 "), "04601234567893");
    assert.equal(normalizeCode("nx-7kq2m9ta"), "NX-7KQ2M9TA");
    const items = [{ item_id: "i1", codes: ["4601234567893"] }, { item_id: "i2", codes: ["14601234567890", "96385074"] }];
    assert.deepEqual(matchReceiving(items, "04601234567893"), ["i1"]);
    assert.deepEqual(matchReceiving(items, "00000096385074"), ["i2"]);
    assert.deepEqual(matchReceiving(items, "2000000000001"), []);
  });
});

describe("scan addresses of an operation in progress", () => {
  it("keep the page's own parameters and replace the parts of the previous scan", () => {
    assert.equal(scanHref("NX-7KQ2M9TA", "scanner", "/m/count/c1?location=l1&code=OLD&batch=X&success=ok"), "/m/count/c1?location=l1&via=scanner&code=NX-7KQ2M9TA");
    assert.equal(scanHref("(01)04601234567893(10)LOT-77", "camera", "/m/move?balance=b"), "/m/move?balance=b&via=camera&code=04601234567893&batch=LOT-77");
    assert.equal(scanHref("NX-7KQ2M9TA", "manual"), "/m/scan?via=manual&code=NX-7KQ2M9TA");
  });
});
