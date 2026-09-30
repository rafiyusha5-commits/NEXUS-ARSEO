import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferDocumentTypeId, titleFromFileName } from "../../src/lib/documents/bulk.ts";

const types = [
  { id: "invoice-id", code: "invoice", name: "Инвойс" },
  { id: "order-id", code: "transport_order", name: "Договор-заявка" },
  { id: "driver-id", code: "driver_document", name: "Документ водителя" },
  { id: "vehicle-id", code: "vehicle_document", name: "Документ автомобиля" },
];

describe("bulk document upload helpers", () => {
  it("suggests common source types from file names", () => {
    assert.equal(inferDocumentTypeId("Invoice 458.pdf", types), "invoice-id");
    assert.equal(inferDocumentTypeId("Договор-заявка Rokos.docx", types), "order-id");
    assert.equal(inferDocumentTypeId("Удостоверение водителя.jpg", types), "driver-id");
    assert.equal(inferDocumentTypeId("Техпаспорт прицепа.pdf", types), "vehicle-id");
  });

  it("leaves an unknown file for the employee to classify", () => {
    assert.equal(inferDocumentTypeId("прочее.pdf", types), "");
  });

  it("uses a clean file name as the default title", () => {
    assert.equal(titleFromFileName("Договор_заявка_№ 41.1.pdf"), "Договор заявка № 41.1");
  });
});
