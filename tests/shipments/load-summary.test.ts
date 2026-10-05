import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShipmentLoadSummary } from "../../src/lib/shipments/load-summary.ts";

const packaging = [
  { product_id: "p1", uom: "piece", units_per_parent: 1, net_weight_kg: 0.175, gross_weight_kg: 0.18 },
  { product_id: "p1", uom: "box", units_per_parent: 22, net_weight_kg: 3.85, gross_weight_kg: 4.34 },
  { product_id: "p1", uom: "pallet", units_per_parent: 1760, net_weight_kg: null, gross_weight_kg: 341.8 },
  { product_id: "p1", uom: "truck", units_per_parent: 58080, net_weight_kg: null, gross_weight_kg: 11279.4 },
];

describe("shipment load summary", () => {
  it("treats pallet and truck values as cumulative pieces", () => {
    const summary = buildShipmentLoadSummary([
      { id: "i1", product_id: "p1", shipment_transport_id: "t1", uom: "truck", ordered_quantity: 1 },
    ], packaging);
    assert.equal(summary.pieces, 58080);
    assert.equal(summary.boxes, 2640);
    assert.equal(summary.pallets, 33);
    assert.equal(summary.grossWeightKg, 11279.4);
  });

  it("prefers shipped then confirmed quantity and warns about unallocated goods", () => {
    const summary = buildShipmentLoadSummary([
      { id: "i1", product_id: "p1", shipment_transport_id: null, uom: "box", ordered_quantity: 20, confirmed_quantity: 12, shipped_quantity: 10 },
    ], packaging);
    assert.equal(summary.pieces, 220);
    assert.equal(summary.boxes, 10);
    assert.equal(summary.pallets, 0.125);
    assert.ok(summary.lines[0].warnings.includes("Товар не распределён по автомобилю"));
  });

  it("keeps unknown values explicit instead of presenting false zeroes", () => {
    const summary = buildShipmentLoadSummary([
      { id: "i2", product_id: "p2", shipment_transport_id: "t1", uom: "box", ordered_quantity: 5 },
    ], []);
    assert.equal(summary.lines[0].pieces, null);
    assert.equal(summary.lines[0].grossWeightKg, null);
    assert.ok(summary.lines[0].warnings.includes("Не хватает данных для веса брутто"));
  });
});
