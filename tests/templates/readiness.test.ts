import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShipmentDocumentReadiness } from "../../src/lib/templates/readiness.ts";

const complete = {
  shipment_number: "NAR-1", planned_ready_date: "01.10.2026", supplier_name: "Fazer", customer_name: "ARSEO",
  loading_address: "Vantaa", destination_address: "Almaty", order_number: "HS-41.1", invoice_number: "INV-1",
  items: [{ product_name: "Dumle", supplier_sku: "1", gtin: "641", hs_code: "1704", country_of_origin: "FI", piece_count: "100", box_count: "10", pallet_count: "1", total_net_weight_kg: "12", total_gross_weight_kg: "13" }],
  transports: [{ carrier_name: "Carrier", vehicle_plate: "123ABC", trailer_plate: "456DEF", driver_name: "Driver", temperature_setpoint: "+15" }],
};

describe("shipment document readiness", () => {
  it("accepts a complete transport document data set", () => {
    const result = buildShipmentDocumentReadiness(complete, ["invoice_number", "loading_address"]);
    assert.equal(result.ready, true);
    assert.equal(result.requiredMissing, 0);
    assert.equal(result.items.find(item => item.key === "invoice_number")?.source, "Подтверждённый загруженный документ");
  });

  it("separates blocking gaps from recommendations", () => {
    const result = buildShipmentDocumentReadiness({ shipment_number: "NAR-2", items: [], transports: [] });
    assert.equal(result.ready, false);
    assert.ok(result.requiredMissing > 0);
    assert.ok(result.recommendedMissing > 0);
    assert.equal(result.items.find(item => item.key === "items")?.required, true);
  });
});
