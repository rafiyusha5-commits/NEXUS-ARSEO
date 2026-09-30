import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { renderShipmentPdf, type ExportPdfKind } from "../../src/lib/templates/generation-pdf.ts";

const data: Record<string, unknown> = {
  generated_date: "30.09.2026", shipment_number: "EXP-2026-17", project_code: "HS-41.1",
  order_number: "HS-41.1", shipping_date: "30.09.2026", contract_number: "MGDF-164",
  supplier_name: "ТОО ARSEO", supplier_tax_id: "220840052928", supplier_country: "KZ",
  supplier_address: "Казахстан, Астана", customer_name: "ООО МАРКЕТ ГРУПП", customer_tax_id: "7813563649",
  customer_country: "RU", customer_address: "Россия, Московская область",
  loading_address: "г. Актобе, ул. Баншева 7", unloading_address: "Россия, Новоселки",
  total_quantity: "1056", total_gross_weight_kg: "420,5", total_net_weight_kg: "390,2", pallet_count: "4",
  items: [{ product_name: "Конфеты шоколадные Fazer", country_of_origin: "Финляндия", gtin: "6416453453296", ordered_quantity: "1056", total_net_weight_kg: "390,2", total_gross_weight_kg: "420,5", hs_code: "1806901900", box_count: "44", pallet_count: "4" }],
  transports: [{ carrier_name: "TOO Logistics", vehicle_make: "SCANIA", vehicle_plate: "754BA04", trailer_make: "SCHMITZ", trailer_plate: "66DLA04", driver_name: "Иванов Иван", driver_document: "N123456", temperature_setpoint: "+14…+19" }],
};

describe("shipment export PDFs", () => {
  for (const [kind, size] of [["cmr", [612, 792]], ["ttn", [792, 612]], ["packing_list", [792, 612]]] as Array<[ExportPdfKind, number[]]>) {
    it(`creates a printable one-page ${kind}`, async () => {
      const bytes = await renderShipmentPdf(kind, data);
      assert.equal(Buffer.from(bytes).subarray(0, 4).toString(), "%PDF");
      const pdf = await PDFDocument.load(bytes);
      assert.equal(pdf.getPageCount(), 1);
      const page = pdf.getPage(0);
      assert.equal(Math.round(page.getWidth()), size[0]);
      assert.equal(Math.round(page.getHeight()), size[1]);
    });
  }
});
