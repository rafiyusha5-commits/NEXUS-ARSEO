import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSupplierLayout, SUPPLIER_LAYOUT_MARKER } from "../../src/lib/document-extraction/supplier-layout.ts";
import { parseCustomsForm } from "../../src/lib/document-extraction/customs.ts";
import { comparePackingQuantities } from "../../src/lib/document-extraction/packing-evidence.ts";
import { extractionNeedsReview, extractShipmentFields, sanitizeConfirmedSourceData } from "../../src/lib/document-extraction/rules.ts";

// Synthetic forms: different quantities, dates, identifiers and prices from production.
const invoice = `Trolli GmbH
Invoice | 98765432
Currency | EUR
Total Quantity:
3 | PC
2 | CAR
10 | 001234 | DP Example sweets 100x50g | dimensions
Customs tariff no.: | 17049065
20 | 005678
Example sweets 24x50g | dimensions
Customs tariff no.: | 17049065
Price | 0.50 | EUR | per | 1 | PC | 150.00
300 | PC
Price | 0.50 | EUR | per | 1 | PC | 150.00
0 | KG
40 | 123456 | Example rings 12x100g
Customs tariff no.: | 17049065
Price | 0.50 | EUR | per | 1 | BAG | 12.00
2 | CAR
Price | 0.50 | EUR | per | 1 | BAG | 12.00
Final amount: | 162.00`;
const packing = `Trolli GmbH
Delivery Note 87654321
10 | 001234 | 8 | 20.00 | KG
DP Example sweets 100x50g | 1
0000000001 | 08.02.2028 | 1.00 | PC
T000000002 | 30.12.2027 | 2.00 | PC
000020 | 005678
Example sweets 24x50g
300 | PC
Parent item: | 10
30 | 123456 | 72 | 4.00 | KG
Example rings 12x100g | 1
0000000003 | 20.01.2028 | 2.00 | CAR
Carton: | 2
Pieces: | 3
Euro-Palette EPAL NEU | 2`;
const source = (s: string) => s + SUPPLIER_LAYOUT_MARKER + s;
test("display invoice counts priced contents once under the DP parent and validates PC/CAR totals", () => {
  const result = parseSupplierLayout(source(invoice))!.invoice!;
  assert.deepEqual(result.items.map(i => [i.sku, i.quantity, i.amount]), [["001234", 300, 150], ["123456", 24, 12]]);
  assert.deepEqual(result.warnings, []);
  assert.match(result.items[0].description, /005678/);
  assert.equal(extractionNeedsReview(extractShipmentFields(source(invoice)).data), false);
  assert.equal(sanitizeConfirmedSourceData(extractShipmentFields(source(invoice)).data).commodity_invoice, undefined);
});
test("packing converts PC display batches, preserves prefixed batch evidence and skips explicit child only once", () => {
  const result = parseSupplierLayout(source(packing))!.packing!;
  assert.deepEqual(result.items.map(i => [i.sku, i.quantity]), [["001234", 100], ["001234", 200], ["123456", 24]]);
  assert.equal(result.total, 324); assert.deepEqual(result.warnings, []);
  assert.equal(comparePackingQuantities(parseSupplierLayout(source(invoice))!.invoice!.items, ["87654321"], [result]).matched, true);
});
test("unknown display relationships, extra prices, missing boxes or inconsistent totals never pass", () => {
  const broken = [
    invoice.replace("DP Example", "Example"), invoice.replace("3 | PC", "4 | PC"),
    invoice.replace("100x50g", "99x50g"), invoice.replace("Example sweets 24x50g", "Different sweets 24x50g"),
    invoice.replace("20 | 005678", "30 | 005678"), invoice.replace("40 | 123456", "50 | 123456"),
    invoice.replace("300 | PC", "unread | PC"), invoice.replace("0.50 | EUR | per | 1 | PC", "0.60 | EUR | per | 1 | PC"),
    invoice.replace("Price | 0.50 | EUR | per | 1 | PC", "Price | 0.50 | EUR | per | 1 | BAG"),
    invoice.replace("Final amount: | 162.00", "Final amount: | 163.00"),
    invoice.replace("20 | 005678", "Price | 1.00 | EUR | per | 1 | PC | 300.00\n20 | 005678"),
    packing.replace("Parent item: | 10", "Parent item: | 30"), packing.replace("Parent item: | 10", ""),
    packing.replace("300 | PC", "301 | PC"), packing.replace("Pieces: | 3", "Pieces: | 4"),
    packing.replace("T000000002", "0000000001"), packing.replace("30.12.2027", "32.12.2027"),
    packing.replace("2.00 | PC", "unread | PC"), packing.replace("2.00 | CAR", "2.00 | PC"),
  ];
  for (const text of broken) assert.equal(extractionNeedsReview(extractShipmentFields(source(text)).data), true, text);
});

const declaration = `ДЕКЛАРАЦИЯ | НА | ТОВАРЫ
50123/030226/0000123
5 | Всего | т | - | ов | 6 Всего мест
1 | 2
12 | Общая | таможенная | стоимость
1000,00 |
22 | Валюта | и общая сумма по счету | 23 | Курс | валюты
KZ | EUR | 162,00 | 550,25
Маркировка | и | количество | 32 | Товар | 33 | Код | товара
31
Грузовые
С | N
1
места | и
1704906500 | D0110
1. | Example sweets
a | DE | b | | 6,000 | | OOOOZOO
37 ПРОЦЕДУРА | 38 Вес нетто
4000 | 000 | 5,400 |
42 | Цена | товара | 43 Код МОС
162,00 | 1
45 | Таможенная | стоимость
1000,00
46 | Статистическая | стоимость
47
\f
Графа | 31 | Описание | товара
1 | ГРУППА | ТОВАРОВ 1:
АРТИКУЛ | 001234; КОЛИЧЕСТВО | 300 | ШТ | ;`;
test("word-cell labels on the first customs page retain the first goods row and header totals", () => {
  for (const text of [declaration, declaration.replaceAll(" ", "\u00a0")]) {
    const result = parseCustomsForm(text)!;
    assert.equal(result.expectedCount, 1);
    assert.deepEqual(result.items?.map(i => [i.sku, i.quantity, i.amount, i.grossKg, i.netKg, i.customsValue]), [["001234", 300, 162, 6, 5.4, 1000]]);
    assert.deepEqual(result.validationWarnings, []);
    assert.deepEqual(sanitizeConfirmedSourceData(extractShipmentFields(text).data), {});
  }
});
test("normalizing labels cannot turn missing goods, conflicting numbers or incomplete totals into agreement", () => {
  for (const text of [
    declaration.replace("1 | 2\n12", "2 | 2\n12"),
    declaration.replace("С | N\n1", "С | N\n2"),
    declaration.replace("1000,00 |", "1001,00 |"),
    declaration.replace("162,00 | 1", "unread | 1"),
    declaration.replace("1704906500 | D0110", "unread | D0110"),
    declaration.replace("АРТИКУЛ | 001234", "АРТИКУЛ | 001234; АРТИКУЛ | 009999"),
  ]) assert.ok(parseCustomsForm(text)!.validationWarnings!.length, text);
});
