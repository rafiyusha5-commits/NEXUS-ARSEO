import assert from "node:assert/strict";
import { test } from "node:test";
import { englishAmount, parseSupplierLayout, SUPPLIER_LAYOUT_MARKER } from "../../src/lib/document-extraction/supplier-layout.ts";
import { extractShipmentFields, extractionNeedsReview, detectShipmentSourceKind, sanitizeConfirmedSourceData } from "../../src/lib/document-extraction/rules.ts";
import { comparePackingQuantities } from "../../src/lib/document-extraction/packing-evidence.ts";
import { customsLayout, parseCustomsForm } from "../../src/lib/document-extraction/customs.ts";

// Synthetic supplier forms; no company/customer documents or identifiers.
const invoice = `Trolli GmbH
Invoice | 12345678
Issue Date | 03 February 2026
Currency | EUR
Delivery terms | EXW | Example City
Net weight: | 4,000.00 | KG | 4,200.00 | KG
Gross weight: | 4,400.00 | KG | Loading equipment: | 200.00 | KG | Pallets: | 20.00
Total Quantity:
5 | CAR
10 | 123456 | Example sweets 12x100g | 12/72/105
4000000000001 | 4000000000002
Customs tariff no.: | 17049065
Price | 0.50 | EUR | per | 1 | BAG | 12.00
2 | CAR
Price | 0.50 | EUR | per | 1 | BAG | 12.00
1.555,200 | KG
\f
Invoice | 12345678
20 | 123457
Example rings 10x100g | dimensions
Price | 0.50 | EUR | per | 1 | BAG | 15.00
3 | CAR
Price | 0.50 | EUR | per | 1 | BAG | 15.00
Total items: | 27.00
Final amount: | 27.00
Amount payable: | 0 | EUR`;
const packing = `Trolli GmbH
Delivery Note 23456789
Incoterms version | Delivery terms | EXW | Destination | Example City
Total gross: | 4,400.00 | KG
10 | 123456 | 72 | 2,000.00 | KG
Example sweets 12x100g | 2
4000000000001 | 17049065
0000000001 | 10.01.2027 | 2.00 | CAR
20 | 123457 | 72 | 2,200.00 | KG
Example rings 10x100g | 3
\f
Document no./date
23456789 | / 03.02.2026
4000000000002 | 17049065
0000000002 | 10.02.2027 | 1.00 | CAR
340704811000000000
0000000003 | 10.03.2027 | 2.00 | CAR
Carton: | 5
Euro-Palette EPAL NEU | 20`;
const source = (s: string) => s + SUPPLIER_LAYOUT_MARKER + s;
test("supplier invoice converts cartons from printed pack size, checks price and ignores repeated price/payment balance", () => {
  const result = parseSupplierLayout(source(invoice))!;
  assert.deepEqual(result.invoice?.items.map(i => [i.sku, i.quantity, i.amount]), [["123456", 24, 12], ["123457", 30, 15]]);
  assert.deepEqual(result.invoice?.warnings, []);
  assert.equal(result.invoice?.total, 27);
  assert.equal(result.fields.invoice_date, "2026-02-03");
  assert.equal(result.fields.gross_weight_kg, 4400);
  assert.equal(result.fields.net_weight_kg, 4000);
  assert.equal(result.fields.pallet_count, 20);
  assert.equal(parseSupplierLayout(invoice), null);
});
test("packing joins a continuation on the next page and split batches; GTIN/SSCC are not product rows", () => {
  const result = parseSupplierLayout(source(packing))!;
  assert.deepEqual(result.packing?.warnings, []);
  assert.equal(result.packing?.total, 54);
  assert.deepEqual(result.packing?.items.map(i => i.quantity), [24, 10, 20]);
  assert.equal(result.fields.incoterms, "EXW Example City");
  const lines = parseSupplierLayout(source(invoice))!.invoice!.items;
  assert.equal(comparePackingQuantities(lines, ["23456789"], [result.packing!]).matched, true);
});
test("incomplete supplier data, duplicate rows, ambiguous prices, bad packs and totals always require review", () => {
  for (const broken of [
    invoice.replace("3 | CAR", "unread | CAR"), invoice.replace("10x100g", "?x100g"),
    invoice.replace("10x100g", "99999999999999999x100g"), packing.replace("10x100g", "99999999999999999x100g"),
    invoice.replace("5 | CAR", "6 | CAR"), invoice.replace("Final amount: | 27.00", "Final amount: | 28.00"),
    invoice.replace("20 | 123457", "30 | 123457"), invoice.replace("20 | 123457", "20 | 123456"),
    invoice.replace("Price | 0.50", "Price | 0.60"), invoice.replace("Price | 0.50", "Price | unread"),
    invoice.replace("Invoice | 12345678", "Invoice | 99999999"),
    packing.replace("2.00 | CAR", "unread | CAR"), packing.replace("Carton: | 5", "Carton: | 6"),
    packing.replace("0000000003", "0000000002"), packing.split("\f")[0],
  ]) {
    const result = extractShipmentFields(source(broken));
    assert.equal(extractionNeedsReview(result.data), true, broken);
  }
});
test("supplier evidence stays out of writable quantities, stock and finances", () => {
  const result = extractShipmentFields(source(invoice));
  assert.equal(result.data.invoice_items, undefined);
  assert.equal(sanitizeConfirmedSourceData(result.data).commodity_invoice, undefined);
  assert.equal(detectShipmentSourceKind(packing), "specification");
  assert.equal(extractionNeedsReview(result.data), false);
  assert.equal(parseSupplierLayout(source(invoice.replaceAll("Trolli GmbH", "Unrecognised form"))), null);
  for (const bad of ["1.000,00", "1,23", "NaN", "-1.00", "1,234,56"]) assert.equal(englishAmount(bad), null);
  assert.equal(englishAmount("1,234.50"), 1234.5);
});
test("PDF glyphs retain words, amounts and distant columns; cells with no width retain boundaries", () => {
  const item = (str: string, x: number, width?: number) => ({ str, width, transform: [1, 0, 0, 1, x, 100] });
  assert.equal(customsLayout([item("Д", 0, 5), item("Т", 5, 5), item("1", 20, 5), item("2", 25, 5), item(",", 30, 2), item("3", 32, 5)]), "ДТ | 12,3");
  assert.equal(customsLayout([item("A", 0), item("B", 5)]), "A | B");
});
test("supporting customs documents cannot be confused with goods declarations or supplier invoices", () => {
  const dts = "Форма ДТС-1\n50123/030226/0000123\n4 Номер и дата счета (счетов)\nlabel | 12345678 03.02.2026\nlabel | 12345 04.02.2026\n5 Номер и дата контракта\n(курс пересчета EUR/550.25)";
  const result = extractShipmentFields(dts);
  assert.equal(parseCustomsForm(dts)?.kind, "value_declaration");
  assert.equal(parseCustomsForm(dts)?.fields.filter(f => f.label.includes("Ссылка на счёт")).length, 2);
  assert.deepEqual(sanitizeConfirmedSourceData(result.data), {});
  assert.equal(parseCustomsForm("ТРАНЗИТНАЯ ДЕКЛАРАЦИЯ\n44 |02015/1/123456 ОТ 03.02.2026")?.kind, "transit");
});

const declaration = `ДЕКЛАРАЦИЯ НА ТОВАРЫ
50123/030226/0000123
5 Всего т-ов | 6 Всего мест
1 | 20
12 Общая таможенная стоимость
1000,00 |
22 Валюта и общая сумма по счету | 23 Курс валюты
KZ | EUR | 27,00 | 550,25
Маркировка и количество | 32 Товар 33 Код товара
31
Грузовые
С N
1
места и
1704906500 | D0110
1. Example goods
a | DE | b | 6,000 |
37 ПРОЦЕДУРА | 38 Вес нетто
 4000 | 000 | 5,400 |
42 Цена товара | 43 Код МОС
27,00 | 1
45 Таможенная стоимость
1000,00
46 Статистическая стоимость
47
\f
Графа 44
1 | 1 | 04021 12345678 | 03.02.2026
1 | 2 | 04031 999999 | 03.02.2026
1 | 3 | 04131 23456789 | 03.02.2026
\f
Графа | 31 | Описание | товара
1 | ГРУППА | ТОВАРОВ 1:
АРТИКУЛ | 123456; КОЛИЧЕСТВО | 54 | ШТ | ;`;
test("fragmented declaration binds explicit appendix quantities to goods boxes and ignores transport invoice references", () => {
  const result = parseCustomsForm(declaration)!;
  assert.deepEqual(result.validationWarnings, []);
  assert.deepEqual(result.invoiceNumbers, ["12345678"]);
  assert.deepEqual(result.packingNumbers, ["23456789"]);
  assert.deepEqual(result.items?.map(i => [i.number, i.sku, i.quantity, i.amount, i.netKg]), [[1, "123456", 54, 27, 5.4]]);
  for (const broken of [declaration.replace("КОЛИЧЕСТВО | 54", "КОЛИЧЕСТВО | unread"), declaration.replace("1 | 20", "2 | 20"), declaration.replace("1000,00 |", "1001,00 |"), declaration.replace("С N\n1", "С N\n2")]) assert.ok(parseCustomsForm(broken)!.validationWarnings!.length);
});
