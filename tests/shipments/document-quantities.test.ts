import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defaultQuantityTarget, documentUnit, itemsInDocumentScope, parseQuantityLines, proposeDocumentQuantities,
} from "../../src/lib/shipments/document-quantities.ts";

const item = (id: string, uom: string, product: Record<string, unknown>, transport: string | null = null) =>
  ({ id, uom, shipment_transport_id: transport, product });

describe("quantities from source documents", () => {
  it("reads common document units and leaves unknown ones to the employee", () => {
    assert.equal(documentUnit("Штука"), "piece");
    assert.equal(documentUnit("шт."), "piece");
    assert.equal(documentUnit("PCS"), "piece");
    assert.equal(documentUnit("Коробка"), "box");
    assert.equal(documentUnit("ctn"), "box");
    assert.equal(documentUnit("Pallets"), "pallet");
    assert.equal(documentUnit("кг"), null);
    assert.equal(documentUnit(""), null);
  });

  it("matches lines by full name, SKU in the line and a unique HS code", () => {
    const items = [
      item("i1", "piece", { internal_sku: "FAZ-001", name: { ru: "Шоколад молочный 100 г", en: "Milk chocolate 100 g" }, hs_code: "1806321000" }),
      item("i2", "piece", { internal_sku: "FRO-014", name: { ru: "Смузи манго" }, hs_code: "2009899700" }),
      item("i3", "box", { internal_sku: "XX-1", name: { ru: "Печенье" }, hs_code: "1905319100" }),
    ];
    const lines = [
      { line_number: 1, product_name: "MILK CHOCOLATE 100G", hs_code: "1806321000", uom: "pcs", quantity: 960 },
      { line_number: 2, product_name: "Smoothie mango FRO-014 250ml", hs_code: "2009899700", uom: "шт", quantity: 480 },
      { line_number: 3, product_name: "Biscuits", hs_code: "1905 31 91 00", uom: "Коробка", quantity: 40 },
    ];
    const proposals = proposeDocumentQuantities(items, lines);
    assert.deepEqual(proposals.map(p => [p.itemId, p.quantity, p.matchedBy, p.unitMismatch]), [
      ["i1", 960, "name", false],
      ["i2", 480, "sku", false],
      ["i3", 40, "hs_code", false],
    ]);
  });

  it("never converts another unit and never guesses between equal candidates", () => {
    const items = [
      item("i1", "box", { internal_sku: "A-001", name: { ru: "Товар А" }, hs_code: "1806321000" }),
      item("i2", "piece", { internal_sku: "B-001", name: { ru: "Товар Б" }, hs_code: "1806321000" }),
    ];
    const lines = [
      { product_name: "Товар А", uom: "шт", quantity: 240 },
      { product_name: "Другое", hs_code: "1806321000", uom: "шт", quantity: 10 },
      { product_name: "Ещё другое", hs_code: "1806321000", uom: "шт", quantity: 20 },
    ];
    const [first, second] = proposeDocumentQuantities(items, lines);
    assert.equal(first.quantity, null, "240 pieces are not proposed for an item in boxes");
    assert.equal(first.unitMismatch, true);
    assert.equal(first.line?.quantity, 240, "the line is still shown as a hint");
    assert.equal(second.quantity, null, "two items share the HS code: no proposal");
    assert.equal(second.matchedBy, null);
  });

  it("does not give one line to two items", () => {
    const items = [
      item("i1", "piece", { internal_sku: "SKU-1", name: { ru: "Одинаковое имя" } }),
      item("i2", "piece", { internal_sku: "SKU-2", name: { ru: "Одинаковое имя" } }),
    ];
    const proposals = proposeDocumentQuantities(items, [{ product_name: "Одинаковое имя", uom: "шт", quantity: 5 }]);
    assert.deepEqual(proposals.map(p => p.quantity), [null, null]);
  });

  it("limits a vehicle document to the cargo of that vehicle", () => {
    const items = [item("i1", "piece", {}, "t1"), item("i2", "piece", {}, "t2"), item("i3", "piece", {}, null)];
    assert.deepEqual(itemsInDocumentScope(items, "t1").map(i => i.id), ["i1"]);
    assert.deepEqual(itemsInDocumentScope(items, null).map(i => i.id), ["i1", "i2", "i3"]);
  });

  it("chooses the field by the kind of document", () => {
    assert.equal(defaultQuantityTarget("invoice"), "confirmed");
    assert.equal(defaultQuantityTarget("specification"), "shipped");
    assert.equal(defaultQuantityTarget("waybill"), "shipped");
  });

  it("parses the form: empty inputs skipped, decimals with a comma, invalid values refused", () => {
    const a = "a1a1a1a1-1111-4111-8111-111111111111", b = "b2b2b2b2-2222-4222-8222-222222222222";
    assert.deepEqual(parseQuantityLines([["qty_" + a, " 1 250,5 "], ["qty_" + b, ""], ["other", "7"]]), [{ shipment_item_id: a, quantity: 1250.5 }]);
    assert.deepEqual(parseQuantityLines([["qty_" + a, "0"]]), [{ shipment_item_id: a, quantity: 0 }]);
    assert.throws(() => parseQuantityLines([["qty_" + a, "-1"]]), /неотрицательным/);
    assert.throws(() => parseQuantityLines([["qty_" + a, "1.2345"]]), /тремя знаками/);
    assert.throws(() => parseQuantityLines([["qty_" + a, "abc"]]), /неотрицательным/);
    assert.throws(() => parseQuantityLines([["qty_not-an-id", "1"]]), /Некорректная позиция/);
  });
});
