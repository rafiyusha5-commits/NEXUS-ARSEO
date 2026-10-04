import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packagingContentsLabel, sortPackagingLevels } from "../../src/lib/products/packaging.ts";

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
