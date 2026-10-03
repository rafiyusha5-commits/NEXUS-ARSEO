import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canViewShipmentPrices } from "../../src/lib/shipment-report-rules.ts";

describe("shipment report prices", () => {
  it("hides prices when the dedicated permission is absent", () => {
    assert.equal(canViewShipmentPrices(new Set()), false);
    assert.equal(canViewShipmentPrices(new Set(["shipments.view"])), false);
  });

  it("shows prices only when the database granted the permission", () => {
    assert.equal(canViewShipmentPrices(new Set(["prices.purchase.view"])), true);
  });
});
