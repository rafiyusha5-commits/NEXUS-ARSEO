import assert from "node:assert/strict";
import { test } from "node:test";
import { detectShipmentSourceKind, extractShipmentFields } from "../../src/lib/document-extraction/rules.ts";
import { proposeFromOcr } from "../../src/lib/ocr/recognize.ts";

test("CMR references do not change document type; bilingual totals and plates are proposals", () => {
  const text = "MIEDZYNARODOWY SAMOCHODOWY LIST PRZEWOZOWY NR\nCMR 20261102\nINVOICE: 009/2026/Z\nWG1234M/WGM5678S\nTOTAL: 20 Palet 1000 szt. 1 234,500\n";
  assert.equal(detectShipmentSourceKind(text), "waybill");
  assert.equal(detectShipmentSourceKind("INVOICE: 009/2026/Z", "waybill"), "waybill");
  const r = extractShipmentFields(text, { hintedKind: "waybill" });
  assert.equal(r.data.cmr_number, "20261102");
  assert.equal(r.data.pallet_count, 20);
  assert.equal(r.data.gross_weight_kg, 1234.5);
  assert.equal(r.data.vehicle_plate, "WG1234M");
  assert.equal(r.data.trailer_plate, "WGM5678S");
});
test("invoice label is not a number; date and value follow the complete bilingual heading", () => {
  const r = extractShipmentFields("FAKTURA VAT / INVOICE\nNUMER FAKTURY (INVOICE NO): 009/2026/Z\nDATA FAKTURY (INVOICE DATE): 2026-11-01");
  assert.equal(r.data.invoice_number, "009/2026/Z");
  assert.equal(r.data.invoice_date, "2026-11-01");
  assert.equal(extractShipmentFields("CMR No\nНакладная ПО\nИнвойс за").data.cmr_number, undefined);
});
test("despatch note remains packing list and customs form cannot fabricate transport fields", () => {
  const text = "DESPATCH NOTE/ ORDER NR: WZ 12/11/2026EX\nINVOICE reference";
  assert.equal(detectShipmentSourceKind(text), "specification");
  assert.equal(extractShipmentFields(text).data.packing_list_number, "12/11/2026EX");
  assert.deepEqual(extractShipmentFields("ДЕКЛАРАЦИЯ НА ТОВАРЫ\nВодитель: FAZER CONFECTIONARY LTD\nУсловия поставки\n16 Страна происхождения").data, {});
});
test("unread CMR number and ambiguous OCR characters are never guessed", () => {
  const r = proposeFromOcr({text:"MIEDZYNARODOWY SAMOCHODOWY\nINVOICE: 009/2026/2\nTOTAL: 20 Palet 1000 szt. 1 234,500\n",words:[],pageCount:1,confidence:0.93},"waybill");
  assert.equal(r.status,"needs_review");
  assert.equal(r.result.data.invoice_number,"009/2026/2");
  assert.equal(r.result.data.cmr_number,undefined);
  assert.match(r.error!,/Номер CMR не прочитан/);
});
