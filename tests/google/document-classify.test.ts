import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestDocumentType } from "../../src/lib/google/document-classify.ts";

const code = (path: string) => suggestDocumentType(path, path.split(" / ").at(-1)!)?.code ?? null;

describe("suggested document type of a Drive file", () => {
  it("reads the type from the file name", () => {
    assert.equal(code("Перевозка / Договор-заявка №12.pdf"), "transport_order");
    assert.equal(code("Перевозка / CMR AB-50.pdf"), "cmr");
    assert.equal(code("Закуп / Invoice 2026-118.pdf"), "invoice");
    assert.equal(code("Закуп / Проформа.pdf"), "invoice");
    assert.equal(code("Закуп / Packing list.xlsx"), "packing_list");
    assert.equal(code("Закуп / Спецификация 3.pdf"), "specification");
    assert.equal(code("Растаможка / ДТ 10228010.pdf"), "customs_declaration");
    assert.equal(code("Закуп / Сертификат соответствия.pdf"), "certificate");
    assert.equal(code("Закуп / Декларация о соответствии ЕАЭС.pdf"), "certificate");
    assert.equal(code("Контракт поставки.pdf"), "supplier_contract");
    assert.equal(code("Гарантийное письмо.docx"), "guarantee_letter");
    assert.equal(code("СНТ_45.pdf"), "snt");
  });

  it("uses the subfolder when the name says nothing", () => {
    assert.equal(code("Растаможка / Результат растаможки / скан 001.pdf"), "customs_declaration");
    assert.equal(code("Растаможка / ЧЗ / 4600000000001.csv"), "marking_codes_file");
    assert.equal(code("Стикеры / товар 1.pdf"), "sticker_layout");
  });

  it("suggests nothing it cannot tell", () => {
    assert.equal(code("Закуп / скан 001.pdf"), null);
    assert.equal(code("Перевозка / фото.jpg"), null);
    assert.equal(code("Растаможка / письмо брокера.pdf"), null);
  });

  it("does not take a part of a word for a short code", () => {
    assert.equal(code("Закуп / Детские сладости.pdf"), null);
    assert.equal(code("Закуп / Смраморный.pdf"), null);
  });
});
