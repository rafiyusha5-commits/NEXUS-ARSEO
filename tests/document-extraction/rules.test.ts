import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { conflictsAcrossDocuments, extractShipmentFields, mergeConfirmedSourceData } from "../../src/lib/document-extraction/rules.ts";

describe("shipment source document extraction", () => {
  it("extracts transport and order fields from a contract request", () => {
    const result = extractShipmentFields(`
      Заказ № HS-41.1
      Дата заказа: 14.05.2026
      Дата отгрузки: 23.09.2026
      Фамилия и инициалы водителя: Иванов И.И.
      Гос.номер авто: 754BA04
      Марка авто: SCANIA
      Гос.номер прицепа: 66DLA04
      Наименование перевозчика: ТОО «Rokos logistics»
      Количество паллет: 32
      Номера пломб: 10123, 10124
    `);
    assert.equal(result.data.order_number, "HS-41.1");
    assert.equal(result.data.order_date, "2026-05-14");
    assert.equal(result.data.shipping_date, "2026-09-23");
    assert.equal(result.data.vehicle_plate, "754BA04");
    assert.equal(result.data.trailer_plate, "66DLA04");
    assert.equal(result.data.pallet_count, 32);
    assert.match(String(result.data.carrier_name), /Rokos logistics/u);
  });

  it("reports only materially different values across source documents", () => {
    const conflicts = conflictsAcrossDocuments([
      { documentId: "invoice", result: { data: { vehicle_plate: "754 BA 04", pallet_count: 32 }, evidence: {}, conflicts: [] } },
      { documentId: "order", result: { data: { vehicle_plate: "755 BA 04", pallet_count: 32 }, evidence: {}, conflicts: [] } },
    ]);
    assert.deepEqual(conflicts.map(item => item.field), ["vehicle_plate"]);
    assert.deepEqual(conflicts[0].documents, ["invoice", "order"]);
  });

  it("overlays confirmed source values onto shipment and first transport", () => {
    const merged = mergeConfirmedSourceData(
      { shipment_number: "EXP-1", items: [{ product_name: "Dumle" }], transports: [{ vehicle_plate: "OLD", driver_name: "" }] },
      [{ vehicle_plate: "754BA04", driver_name: "Иванов И.И." }],
    );
    assert.equal((merged.transports as Array<Record<string, unknown>>)[0].vehicle_plate, "754BA04");
    assert.equal((merged.transports as Array<Record<string, unknown>>)[0].driver_name, "Иванов И.И.");
    assert.deepEqual(merged.items, [{ product_name: "Dumle" }]);
  });
});
