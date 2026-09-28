import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canViewShipmentPrices } from "../../src/lib/shipment-report-rules.ts";

const role = (code: string) => ({ id: code, code, name: code });

describe("shipment report prices", () => {
  it("hides prices from marketers and logistics specialists", () => {
    assert.equal(canViewShipmentPrices([role("marketer")]), false);
    assert.equal(canViewShipmentPrices([role("logistics_specialist")]), false);
  });

  it("shows prices to commercial and accounting roles", () => {
    assert.equal(canViewShipmentPrices([role("commercial_director")]), true);
    assert.equal(canViewShipmentPrices([role("accountant")]), true);
  });

  it("uses the strongest role when an employee has several roles", () => {
    assert.equal(canViewShipmentPrices([role("marketer"), role("director")]), true);
  });
});
