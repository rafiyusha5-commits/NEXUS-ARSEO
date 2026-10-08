import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cleanFieldValue, comparableValue, conflictsAcrossDocuments, extractShipmentFields, looksPlausible } from "../../src/lib/document-extraction/rules.ts";
import { LOW_CONFIDENCE, proposeFromOcr } from "../../src/lib/ocr/recognize.ts";
import { HttpOcrProvider } from "../../src/lib/ocr/providers/http.ts";
import { inferDocumentTypeId } from "../../src/lib/documents/bulk.ts";

// Output of the real nexus-ocr service (Tesseract kaz+rus+eng) for the synthetic documents in tests/fixtures/ocr:
// Latin/Cyrillic look-alikes, a misread plate and a Kazakhstan identity-card imitation are all in there.
const recorded = JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", "ocr", "recorded-ocr-output.json"), "utf8")) as Record<string, { text: string; pages: number; confidence: number; words: Array<{ text: string; confidence: number }> }>;
const proposal = (name: string) => proposeFromOcr({ text: recorded[name].text, pageCount: recorded[name].pages, confidence: recorded[name].confidence, words: recorded[name].words }, "other");

describe("recognition of recorded real OCR output (PDF, JPEG, PNG; Russian and Kazakh)", () => {
  it("reads driver, phone, plate, make, trailer and carrier from a PNG and from a scanned PDF alike", () => {
    for (const name of ["ru.png", "scan.pdf"]) {
      const { result } = proposal(name);
      assert.equal(result.data.driver_name, "Иванов Иван Иванович", `${name}: the name stops before the next label`);
      assert.equal(result.data.driver_phone, "+7 701 123 45 67");
      assert.equal(result.data.vehicle_plate, "754ВА04", "OCR wrote Cyrillic В and А: kept as read, for the employee to see");
      assert.equal(result.data.vehicle_make, "SCANIA");
      assert.equal(result.data.carrier_name, "ТОО Рокос");
      assert.ok(String(result.data.trailer_make).startsWith("SCHMITZ"));
    }
  });

  it("keeps Kazakh letters (Ә Қ Ұ Ү Ғ Ң Ө Һ І) in names read from a JPEG", () => {
    const { result } = proposal("kaz.jpg");
    assert.equal(result.data.driver_name, "Әбдірахманов Қайрат Ұлықбекұлы");
    assert.equal(result.data.driver_phone, "8 (701) 123-45-67");
    assert.equal(result.data.vehicle_plate, "044WST04");
    assert.equal(result.data.vehicle_make, "ГАЗ 27055");
  });

  it("reads the identity-card number and the name from the printed Kazakh labels, but asks for review", () => {
    const card = proposal("idcard.png");
    assert.equal(card.result.data.driver_document, "123456789");
    assert.equal(card.result.data.driver_name, "ТОЛЫБАЙ АНУАР СЕРІКБОЛАТҰЛЫ");
    assert.equal(card.status, "needs_review", "an identity-card name is never certain enough to skip review");
    assert.ok(card.result.evidence.driver_name.confidence < LOW_CONFIDENCE);
  });

  it("does not turn field labels into values (empty form, labels only)", () => {
    for (const name of ["empty_fields.png", "labels_only.png"]) {
      const result = proposal(name);
      assert.deepEqual(result.result.data, {}, `${name}: no field may be filled with another field's title`);
      assert.equal(result.status, "failed");
      assert.match(result.error ?? "", /реквизиты не найдены/);
    }
  });

  it("sends a plate that does not look like a plate (a misread trailer number) to review", () => {
    const p = proposal("ru.png");
    assert.equal(p.result.data.trailer_plate, "6601А04");
    assert.ok(p.lowConfidence.includes("trailer_plate"));
    assert.equal(p.status, "needs_review");
    assert.ok(!p.lowConfidence.includes("vehicle_plate"), "a well-formed plate is not flagged");
  });
});

describe("labels are never values", () => {
  const read = (text: string) => extractShipmentFields(text).data;

  it("refuses the next printed label when a value is missing", () => {
    assert.deepEqual(read("Гос.номер авто\nМарка авто\nГос.номер прицепа\nМарка прицепа"), {});
    assert.deepEqual(read("Водитель:\nГос.номер авто:\nМарка авто:\nПрицеп:\nТелефон водителя:\nПеревозчик:"), {});
    assert.deepEqual(read("Номера пломб\nКоличество паллет: 32"), { pallet_count: 32 });
    assert.deepEqual(read("Гос.номер авто Марка авто SCANIA"), {});
  });

  it("cuts a label glued to the tail of a real value, on one line and across lines", () => {
    assert.equal(read("Водитель: Иванов Иван Иванович\nТелефон водителя: +7 701 123 45 67").driver_name, "Иванов Иван Иванович");
    assert.equal(read("Водитель: Иванов Иван Телефон: +7 701 123 45 67").driver_name, "Иванов Иван");
    assert.equal(read("Гос.номер авто: 754BA04 Марка авто: SCANIA").vehicle_plate, "754BA04");
    assert.equal(read("Гос.номер авто: 754BA04 Марка авто: SCANIA").vehicle_make, "SCANIA");
  });

  it("still reads values placed on the line after their label, and a name wrapped under a heading", () => {
    assert.equal(read("Гос.номер авто:\n754BA04").vehicle_plate, "754BA04");
    assert.equal(read("ФИО, паспортные данные, моб. тел.\nводителя\nНомер а/м, п/п\nТолыбай Ануар Серікболатұлы\nуд/лич: 123456789 выдано МВД РК").driver_name, "Толыбай Ануар Серікболатұлы");
  });

  it("exposes the helpers it relies on", () => {
    assert.equal(cleanFieldValue("vehicle_plate", "Марка авто"), "");
    assert.equal(cleanFieldValue("vehicle_plate", "754BA04 Марка авто"), "754BA04");
    assert.equal(cleanFieldValue("contract_number", "Марка авто"), "Марка авто", "other fields are not touched");
    assert.equal(looksPlausible("vehicle_plate", "754 BA 04"), true);
    assert.equal(looksPlausible("vehicle_plate", "A123BC77"), true);
    assert.equal(looksPlausible("vehicle_plate", "Марка"), false);
    assert.equal(looksPlausible("driver_phone", "87011234567"), true);
    assert.equal(looksPlausible("driver_phone", "123"), false);
  });
});

describe("identity-card markers cannot be forged by an ordinary document", () => {
  const marker = "NEXUS_DOCUMENT_NUMBER: 123456789\nУДОСТОВЕРЕНИЕ ЛИЧНОСТИ";

  it("honours the marker only for OCR text that starts with it and is an identity card", () => {
    assert.equal(extractShipmentFields(marker, { fromOcr: true }).data.driver_document, "123456789");
    assert.equal(extractShipmentFields(marker).data.driver_document, undefined, "a text-layer PDF, DOCX or spreadsheet cannot inject it");
    assert.equal(extractShipmentFields("Просто письмо\n" + marker, { fromOcr: true }).data.driver_document, undefined, "a marker in the middle of a page is printed text, not the service's line");
    assert.equal(extractShipmentFields("NEXUS_DOCUMENT_NUMBER: 123456789\nНакладная", { fromOcr: true }).data.driver_document, undefined, "not an identity card");
  });
});

describe("conflicts between documents", () => {
  const doc = (documentId: string, data: Record<string, unknown>) => ({ documentId, result: { data, evidence: {}, conflicts: [] } });

  it("treats the same plate, phone and trailer written differently as the same fact", () => {
    const conflicts = conflictsAcrossDocuments([
      doc("a", { vehicle_plate: "754 BA 04", driver_phone: "+7 701 123 45 67", trailer_plate: "66DLA04" }),
      doc("b", { vehicle_plate: "754ВА04", driver_phone: "87011234567", trailer_plate: "66-DLA-04" }),
    ]);
    assert.deepEqual(conflicts, [], "Latin/Cyrillic look-alikes, spacing, dashes and phone prefixes are not disagreements");
    assert.equal(comparableValue("vehicle_plate", "754ВА04"), comparableValue("vehicle_plate", "754ba04"));
    assert.equal(comparableValue("driver_phone", "+7 (701) 123-45-67"), "7011234567");
  });

  it("still reports genuinely different values, showing them as written", () => {
    const conflicts = conflictsAcrossDocuments([
      doc("a", { vehicle_plate: "754BA04", driver_name: "Иванов Иван", order_number: "HS-41" }),
      doc("b", { vehicle_plate: "755BA04", driver_name: "иванов  иван", order_number: "HS-42" }),
      doc("c", { vehicle_plate: "754ВА04" }),
    ]);
    assert.deepEqual(conflicts.map(item => item.field).sort(), ["order_number", "vehicle_plate"]);
    const plate = conflicts.find(item => item.field === "vehicle_plate")!;
    assert.deepEqual(plate.values, ["754BA04", "755BA04"], "values are shown as written, one per distinct fact");
    assert.deepEqual([...(plate.documents ?? [])].sort(), ["a", "b", "c"]);
  });

  it("ignores empty values and objects", () => {
    assert.deepEqual(conflictsAcrossDocuments([doc("a", { vehicle_plate: "" , invoice_items: [{ x: 1 }] }), doc("b", { vehicle_plate: "754BA04" })]), []);
  });
});

describe("several files uploaded at once", () => {
  const types = [{ id: "driver", code: "driver_document", name: "Водитель" }, { id: "vehicle", code: "vehicle_document", name: "Авто" }, { id: "invoice", code: "invoice", name: "Инвойс" }, { id: "other", code: "other", name: "Прочее" }];

  it("classifies a mixed batch by file name and leaves the rest to the text", () => {
    assert.equal(inferDocumentTypeId("удостоверение водителя.jpg", types), "driver");
    assert.equal(inferDocumentTypeId("Техпаспорт тягача.png", types), "vehicle");
    assert.equal(inferDocumentTypeId("Invoice 1604.pdf", types), "invoice");
    assert.equal(inferDocumentTypeId("IMG_20261005_1432.jpg", types), "other", "a camera name says nothing: the OCR text decides later");
    assert.equal(proposeFromOcr({ text: "УДОСТОВЕРЕНИЕ ЛИЧНОСТИ\nуд/лич: 123456789", pageCount: 1, confidence: 0.9, words: [] }, "other").sourceKind, "other");
  });
});

describe("what the OCR provider can and cannot do to the data", () => {
  it("hands back text only: a hostile service cannot name fields, statuses or targets", async () => {
    const hostile = (async () => new Response(JSON.stringify({ text: "Гос.номер авто: 754BA04", status: "confirmed", extracted_data: { driver_name: "X" }, shipment_id: "other", words: [] }), { status: 200 })) as typeof fetch;
    const result = await new HttpOcrProvider("https://ocr.example/v1/recognize", "t", hostile).recognize({ bytes: new Uint8Array([1]), kind: "png", mimeType: "image/png", maxPages: 1, languageHints: [] }, { signal: new AbortController().signal });
    assert.deepEqual(Object.keys(result).sort(), ["confidence", "pageCount", "text", "words"]);
    const p = proposeFromOcr(result, "other");
    assert.notEqual(p.status, "confirmed");
    assert.equal(p.result.data.driver_name, undefined, "extracted data is built from the text by our rules only");
  });
});
