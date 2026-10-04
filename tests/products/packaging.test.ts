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
    assert.equal(packagingContentsLabel("piece", 1), "базовая единица");
    assert.equal(packagingContentsLabel("box", 12), "12 штук");
    assert.equal(packagingContentsLabel("pallet", 60), "60 коробов");
    assert.equal(packagingContentsLabel("truck", 33), "33 паллет");
  });
});
