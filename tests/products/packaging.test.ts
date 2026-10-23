import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { convertQuantity, packagingContentsLabel, piecesPerUnit, sortPackagingLevels } from "../../src/lib/products/packaging.ts";

describe("product packaging hierarchy", () => {
  it("shows packaging from a single item up to a truck", () => {
    const levels = sortPackagingLevels([
      { uom: "truck", units_per_parent: 33 },
      { uom: "pallet", units_per_parent: 60 },
      { uom: "piece", units_per_parent: 1 },
      { uom: "box", units_per_parent: 12 },
    ]);

    assert.deepEqual(levels.map((level) => level.uom), ["piece", "box", "pallet", "truck"]);
  });

  it("names the contents of every business packaging level", () => {
    const levels = [
      { uom: "piece", units_per_parent: 1 },
      { uom: "box", units_per_parent: 22 },
      { uom: "pallet", units_per_parent: 1760 },
      { uom: "truck", units_per_parent: 58080 },
    ];

    assert.equal(packagingContentsLabel("piece", 1), "базовая единица");
    assert.equal(packagingContentsLabel("box", 22, levels), "22 штук");
    assert.equal(packagingContentsLabel("pallet", 1760, levels), "1 760 штук · 80 коробов");
    assert.equal(packagingContentsLabel("truck", 58080, levels), "58 080 штук · 33 паллеты · 2 640 коробов");
  });
});

describe("unit conversion through packaging", () => {
  const levels = [
    { uom: "piece", units_per_parent: 1 },
    { uom: "box", units_per_parent: "12.000" },
    { uom: "pallet", units_per_parent: 60 },
  ];

  it("reads units_per_parent as pieces in one unit of the level", () => {
    assert.equal(piecesPerUnit("piece", []), 1);
    assert.equal(piecesPerUnit("box", levels), 12);
    assert.equal(piecesPerUnit("pallet", levels), 60);
    assert.equal(piecesPerUnit("truck", levels), null);
  });

  it("converts exactly to the thousandth, like the database", () => {
    assert.equal(convertQuantity(24, "piece", "box", levels), 2);
    assert.equal(convertQuantity(30, "piece", "box", levels), 2.5);
    assert.equal(convertQuantity(1, "pallet", "box", levels), 5);
    assert.equal(convertQuantity(3, "box", "piece", levels), 36);
    assert.equal(convertQuantity(0.1, "box", "piece", levels), 1.2);
    assert.equal(convertQuantity(5, "piece", "box", levels), null);
    assert.equal(convertQuantity(1, "truck", "piece", levels), null);
    assert.equal(convertQuantity(7, "truck", "truck", levels), 7);
  });
});
