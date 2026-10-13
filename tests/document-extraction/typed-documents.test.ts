import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectShipmentSourceKind, extractShipmentFields, shipmentSourceKindFromDocumentType } from "../../src/lib/document-extraction/rules.ts";

describe("employee-selected shipment document types", () => {
  it("maps CMR, TTN and packing-list types before classifying their contents", () => {
    assert.equal(shipmentSourceKindFromDocumentType("cmr"), "waybill");
    assert.equal(shipmentSourceKindFromDocumentType("ttn"), "waybill");
    assert.equal(shipmentSourceKindFromDocumentType("packing_list"), "specification");
    assert.equal(shipmentSourceKindFromDocumentType("supplier_contract"), "contract");
    assert.equal(shipmentSourceKindFromDocumentType("unknown"), "other");
  });
  it("keeps a CMR as a waybill when its attachments mention an invoice", () => {
    assert.equal(detectShipmentSourceKind("CMR 20261099\nAttached documents: INVOICE 099/2026/Z", "waybill"), "waybill");
  });
  it("does not replace other explicit types with incidental invoice references", () => {
    for (const kind of ["specification", "contract", "transport_order", "vehicle_document", "driver_document"]) {
      assert.equal(detectShipmentSourceKind("Supporting reference: INVOICE 099/2026/Z", kind), kind);
    }
  });
  it("still detects an invoice for an unclassified document", () => {
    assert.equal(detectShipmentSourceKind("INVOICE No FZ-99", "other"), "invoice");
  });
});

describe("bilingual invoice labels", () => {
  it("reads the explicit invoice-number label instead of a heading word", () => {
    const result=extractShipmentFields(`FAKTURA VAT / INVOICE
NUMER FAKTURY (INVOICE NO): 099/2026/Z
DATA FAKTURY (INVOICE DATE): 2026-10-10
Warunki dostawy (Delivery terms): INCO TERM: EXW`);
    assert.equal(result.data.invoice_number,"099/2026/Z");
    assert.equal(result.data.invoice_date,"2026-10-10");
    assert.equal(result.data.incoterms,"EXW");
    assert.equal(result.evidence.invoice_number.value,"099/2026/Z");
  });
  it("does not invent an invoice number from printed labels", () => {
    for(const text of ["INVOICE NUMER", "INVOICE NO", "INVOICE NUMBER", "INVOICE DATE", "Инвойс Номер"]){
      assert.equal(extractShipmentFields(text).data.invoice_number,undefined,text);
    }
  });
  it("keeps existing Russian and English references", () => {
    assert.equal(extractShipmentFields("Инвойс № FZ-99").data.invoice_number,"FZ-99");
    assert.equal(extractShipmentFields("INVOICE No FZ-99").data.invoice_number,"FZ-99");
  });
});
