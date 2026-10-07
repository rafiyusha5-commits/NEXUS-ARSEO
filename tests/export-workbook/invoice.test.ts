import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isElectronicInvoice, parseElectronicInvoice } from "../../src/lib/document-extraction/esf.ts";
import { detectShipmentSourceKind, extractShipmentFields, sanitizeConfirmedSourceData } from "../../src/lib/document-extraction/rules.ts";
import { buildExportModel } from "../../src/lib/export-workbook/model.ts";
import { preflightExport } from "../../src/lib/export-workbook/preflight.ts";
import { baseData, makeItems } from "./helpers.ts";

// Text layer of an electronic invoice (pdf-parse output): labels and values on separate lines, names
// printed twice and wrapped differently, the column-number row repeated at a page break. Invented data only.
const COLUMN_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22"].join("\n");
const INVOICE_TEXT = `
СЧЕТ-ФАКТУРА
Раздел А. Общий раздел
1. Регистрационный номер
ESF-000000000001-20300110-00000001
1.1 Номер учетной системы
777
2. Дата выписки
2.1 Дата выписки на бумажном носителе
10.01.2030
3. Дата совершения оборота
10.01.2030
Раздел B. Реквизиты поставщика
6. ИИН/БИН
6.1 БИН реорганизованного лица
000000000001
7. Поставщик
7.1 Доля участия
Товарищество с ограниченной
ответственностью "Тест-Продавец"8. Место нахождения
ТЕСТЛАНДИЯ, Область, г. Тестоград, ул. Заводская, д. 2, оф.
4б9. Дата постановки на регистрационный учет плательщика9.1 Структурное подразделение
31.08.2020
Раздел C. Реквизиты получателя
16. ИИН/БИН
16.1 БИН реорганизованного лица
0000000002
17. Получатель
17.1 Доля участия
ООО "Тест-Покупатель"
18. Место нахождения
Тестландия, Область, г. Город-А,
ул. Складская, 5
18.1 Код страны
RU
Раздел Е. Договор (контракт)
27.1
Договор (контракт) на поставку товаров,
27.3 Номер
T-777
27.2
27.4 Дата
31.12.2029
31. Пункт назначения31.1 Условия поставки
DAP
Раздел G. Данные по товарам, работам, услугам
No
Наименование
${COLUMN_NUMBERS}
1/1
2
ТЕСТОВЫЙ ТОВАР
АЛЬФА 100Г
ТЕСТОВЫЙ
ТОВАР АЛЬФА
100Г
0000000001
Штука
1 000
100
100 000
100 000
0
0
100 000
1/2
2
ТЕСТОВЫЙ ТОВАР БЕТА
С ДОБАВКОЙ 200Г
${COLUMN_NUMBERS}
ТЕСТОВЫЙ ТОВАР БЕТА С
ДОБАВКОЙ 200Г
0000000002
Штука
2 500
200,50
501 250
501 250
0
0
501 250
Всего по счету-фактуре
`;

describe("electronic invoice reader", () => {
  it("recognises the form and reads the header by box numbers", () => {
    assert.equal(isElectronicInvoice(INVOICE_TEXT), true);
    assert.equal(isElectronicInvoice("Накладная № 1\nдата 01.01.2030"), false);
    const { data } = parseElectronicInvoice(INVOICE_TEXT);
    assert.equal(data.invoice_number, "ESF-000000000001-20300110-00000001");
    assert.equal(data.esf_number, "777");
    assert.equal(data.invoice_date, "2030-01-10");
    assert.equal(data.shipping_date, "2030-01-10");
    assert.equal(data.supplier_name, 'Товарищество с ограниченной ответственностью "Тест-Продавец"');
    assert.equal(data.supplier_address, "ТЕСТЛАНДИЯ, Область, г. Тестоград, ул. Заводская, д. 2, оф. 4б");
    assert.equal(data.customer_name, 'ООО "Тест-Покупатель"');
    assert.equal(data.customer_address, "Тестландия, Область, г. Город-А, ул. Складская, 5");
    assert.equal(data.unloading_address, data.customer_address);
    assert.equal(data.contract_number, "T-777");
    assert.equal(data.contract_date, "2029-12-31");
    assert.equal(data.incoterms, "DAP");
  });

  it("reads wrapped item names once, numbers with thousand separators and survives a page break inside a row", () => {
    const { items } = parseElectronicInvoice(INVOICE_TEXT);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { line_number: 1, product_name: "ТЕСТОВЫЙ ТОВАР АЛЬФА 100Г", hs_code: "0000000001", uom: "Штука", quantity: 1000, unit_price: 100, line_total: 100000 });
    assert.equal(items[1].product_name, "ТЕСТОВЫЙ ТОВАР БЕТА С ДОБАВКОЙ 200Г");
    assert.equal(items[1].quantity, 2500);
    assert.equal(items[1].unit_price, 200.5, "decimal comma");
    assert.equal(items[1].line_total, 501250);
  });

  it("feeds the extraction pipeline: kind, header fields, structured lines kept out of confirmed data", () => {
    assert.equal(detectShipmentSourceKind(INVOICE_TEXT, "other"), "invoice");
    const result = extractShipmentFields(INVOICE_TEXT);
    assert.equal(result.data.esf_number, "777");
    assert.equal(result.data.contract_number, "T-777");
    assert.equal(result.evidence.esf_number.confidence, 0.95);
    assert.equal(Array.isArray(result.data.invoice_items) && result.data.invoice_items.length, 2);
    assert.equal("invoice_items" in sanitizeConfirmedSourceData(result.data), false, "lines are read from the extraction, not typed field by field");
  });
});

describe("invoice reconciliation in the export model", () => {
  const lines = [
    { product_name: "ТЕСТОВЫЙ ТОВАР 1", hs_code: "0000000001", quantity: 1000, unit_price: 123.45, line_total: 123450 },
    { product_name: "Чужой товар", hs_code: "0000000009", quantity: 7, unit_price: 5, line_total: 35 },
  ];

  it("takes the invoice price for matched items only when prices are requested", () => {
    const withPrices = buildExportModel(baseData(makeItems(1), { invoice_lines: lines, prices_included: true }));
    assert.equal(withPrices.items[0].unitPrice, 123.45, "name match ignores case and punctuation");
    const without = buildExportModel(baseData(makeItems(1, () => ({ unit_price: null })), { invoice_lines: lines, prices_included: false }));
    assert.equal(without.items[0].unitPrice, null);
    assert.equal(without.includesPrices, false);
  });

  it("reports differences with the shipment instead of silently choosing one side", () => {
    const model = buildExportModel(baseData(makeItems(2, index => index === 0 ? { piece_count: 900 } : {}), { invoice_lines: lines, prices_included: true }));
    assert.ok(model.invoiceNotes.some(note => note.includes("900 шт. в поставке, 1000 шт. в инвойсе")));
    assert.ok(model.invoiceNotes.some(note => note.includes("Позиция 2") && note.includes("не найдена среди строк инвойса")));
    assert.ok(model.invoiceNotes.some(note => note.includes("Чужой товар") && note.includes("отсутствует в поставке")));
    const result = preflightExport(model, ["workbook"]);
    assert.ok(result.issues.some(issue => issue.key.startsWith("invoice.") && issue.severity === "recommended"));
    assert.equal(result.ready, true, "differences are warnings, they do not block issuing");
  });

  it("matches by HS code and quantity when names differ, and fills a missing HS code", () => {
    const model = buildExportModel(baseData(makeItems(1, () => ({ product_name: "Совсем другое имя", hs_code: "" })), { invoice_lines: [{ product_name: "X", hs_code: "0000000001", quantity: 1000, unit_price: 9 }], prices_included: true }));
    assert.equal(model.items[0].unitPrice, 10, "HS code was empty, so no pairing by code and quantity: the item keeps its own price");
    assert.ok(model.invoiceNotes.some(note => note.includes("не найдена среди строк инвойса")));
    const paired = buildExportModel(baseData(makeItems(1, () => ({ product_name: "Совсем другое имя" })), { invoice_lines: [{ product_name: "X", hs_code: "0000000001", quantity: 1000, unit_price: 9 }], prices_included: true }));
    assert.equal(paired.items[0].unitPrice, 9);
  });

  it("is silent when no invoice was confirmed", () => {
    assert.deepEqual(buildExportModel(baseData(makeItems(2))).invoiceNotes, []);
  });
});
