import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildShipmentGenerationData, generatedFileName, missingGenerationFields } from "../../src/lib/templates/generation.ts";

const base = {
  shipment: { shipment_number: "IMP-2026-0042", project_code: "KV-04", type: "import", status: "in_transit", incoterms: "FCA", planned_arrival_date: "2026-10-10" },
  supplier: { legal_name: "Fazer Finland Oy", tax_id: "FI123", country: "FI" },
  customer: { short_name: "ARSEO", tax_id: "KZ456", country: "KZ" },
  route: { name: { ru: "Финляндия — Казахстан" } }, warehouse: { name: { ru: "Алматы" }, address: "Алматы" }, responsible: { full_name: "Рафика" },
  currency: { code: "EUR" }, contract: { number: "FZ-2026" },
  items: [{ product_id: "p1", uom: "box", ordered_quantity: 10, confirmed_quantity: null, unit_price: 12.5 }],
  products: new Map([["p1", { internal_sku: "DUM-120", name: { ru: "Ирис Dumle 120 г" }, brand: "Dumle", hs_code: "170490", country_of_origin: "FI" }]]),
  identifiers: [
    { product_id: "p1", identifier_type: "gtin", value: "6411401037215", is_primary: true },
    { product_id: "p1", identifier_type: "gtin", value: "OLD", is_primary: false },
  ],
  packaging: [{ product_id: "p1", uom: "box", gross_weight_kg: 1.5, net_weight_kg: 1.2 }],
  transports: [{ sequence_no: 1, driver_name: "Иван", carrier: { counterparty: { short_name: "Carrier" } }, vehicle: { plate_number: "123ABC" } }],
  now: new Date("2026-09-29T00:00:00Z"),
};

describe("shipment document generation data", () => {
  it("builds repeatable shipment, item and transport fields without inventing zero values", () => {
    const data = buildShipmentGenerationData({ ...base, includePrices: false });
    assert.equal(data.shipment_number, "IMP-2026-0042");
    assert.equal(data.items[0].gtin, "6411401037215", "the primary identifier wins");
    assert.equal(data.items[0].confirmed_quantity, "", "an unknown quantity stays blank");
    assert.equal(data.items[0].unit_price, "", "prices stay out of ordinary documents");
    assert.equal(data.total_amount, "");
    assert.equal(data.total_gross_weight_kg, "15");
    assert.equal(data.transports[0].carrier_name, "Carrier");
    assert.equal(data.transports[0].vehicle_plate, "123ABC");
  });

  it("includes financial values only when explicitly enabled", () => {
    const data = buildShipmentGenerationData({ ...base, includePrices: true });
    assert.equal(data.items[0].unit_price, "12,5");
    assert.equal(data.items[0].line_total, "125");
    assert.equal(data.total_amount, "125");
  });

  it("reports missing scalar fields and empty loops used by the template", () => {
    const missing = missingGenerationFields([
      { key: "shipment_number", label: "Поставка" },
      { key: "driver_name", label: "Водитель" },
      { key: "items", label: "Товары" },
    ], { shipment_number: "IMP-1", driver_name: "", items: [] });
    assert.deepEqual(missing.map((field) => field.key), ["driver_name", "items"]);
  });

  it("validates fields inside every item or transport loop", () => {
    const missing = missingGenerationFields([{ key: "gtin", label: "GTIN" }], {
      items: [{ gtin: "6411401037215" }, { gtin: "" }], transports: [],
    });
    assert.deepEqual(missing.map((field) => field.key), ["gtin"]);
  });

  it("creates a stable DOCX file name", () => {
    assert.equal(generatedFileName("CMR клиента.docx", "IMP/2026 42"), "CMR-клиента-IMP-2026-42.docx");
  });
});
