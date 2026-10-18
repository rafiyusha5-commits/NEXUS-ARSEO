import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCommodities, currentCommoditySource, INVOICE_LAYOUT_MARKER, parseCommodityInvoice, parseDeclarationItems, type CommodityInvoice, type ShipmentCommodity } from "../../src/lib/document-extraction/commodity-evidence.ts";
import { parseCustomsForm } from "../../src/lib/document-extraction/customs.ts";
import { extractShipmentFields, sanitizeConfirmedSourceData } from "../../src/lib/document-extraction/rules.ts";

const body = `31 Грузовые | 32 Товар | 33 Код товара
1 | 1806901900
1. TEST CANDY 100Г,
FI | | 1,200 | ООООZОО
37 ПРОЦЕДУРА | 38 Вес нетто (кг)
4000 | 000 | 1,000
42 Цена товара | 43.Код МОС
44. Дополнит. | 20,00 | 1
45 Таможенная стоимость
 | 11000,00
46 Статистическая стоимость
47 Исчисление
1010 | 20,00 | 1
`;
const appendix = `Графа 31 Описание товара
No Товара | Комментарии
1 | 1. TEST CANDY АРТИКУЛ: TEST-A ОБЩЕЕ КОЛИЧЕСТВО В ЕД.
ФИЗ. ОБЪЕМА: 10 ШТ
Графа 44 Дополнительная информация
1 | 8 | 04021 | INV-123 | 2026/03/11 | Инвойс
`;
const raw = `ДЕКЛАРАЦИЯ НА ТОВАРЫ
5 Всего т-ов | 6 Всего мест
1 | 1
12 ОБЩАЯ ТАМОЖЕННАЯ СТОИМОСТЬ
PL | 11000,00
22 Валюта | 23 Курс валюты
EUR | 20,00 | 550,00 | 021
${body}\f${appendix}`;
const invoiceRaw = `FAKTURA VAT / INVOICE Kod EAN${INVOICE_LAYOUT_MARKER}INVOICE NO): | INV-123
LP. | Kod EAN | JM/unit
1 | TEST-A | Candy | 0,10 | 1234567890123 | sztuka | 10 | 2,00 | 20,00 | 0 | 0 | 20,00
Total (Razem) EUR: | 20,00 | 20,00`;
const lines = () => parseDeclarationItems(raw).items;
const invoice = () => parseCommodityInvoice(invoiceRaw)!;
const shipment = (): ShipmentCommodity[] => [{ sku: "TEST-A", unit: "piece", ordered: 10, confirmed: 10, shipped: 10, hsCode: "1806901900" }];
const compare = (invoices: CommodityInvoice[] = [invoice()], positions = shipment()) => compareCommodities(lines(), "EUR", invoices, positions)[0];

test("DT joins explicit appendix SKU/quantity to numbered item; totals exclude payment boxes and appendix copies", () => {
  const result = parseCustomsForm(raw)!;
  assert.equal(result.items?.length, 1);
  assert.deepEqual(result.items?.[0], { number: 1, sku: "TEST-A", description: "TEST CANDY 100Г", hsCode: "1806901900", quantity: 10, unit: "ШТ", amount: 20, grossKg: 1.2, netKg: 1, customsValue: 11000, warnings: [] });
  assert.deepEqual(result.invoiceNumbers, ["INV-123"]);
  assert.ok(result.fields.some(f => f.label.includes("графа 22") && f.value.includes("совпадает")));
  assert.equal(parseDeclarationItems(raw + "\fNo | Код товара\n1 | 1806901900").items.length, 1);
});
test("missing or ambiguous appendix never guesses quantity from kilograms or uses HS as SKU", () => {
  for (const bad of [raw.replace(appendix, ""), raw.replace(appendix, appendix.replace("Графа 44", "1 | 1. OTHER АРТИКУЛ: TEST-B ОБЩЕЕ КОЛИЧЕСТВО В ЕД. ФИЗ. ОБЪЕМА: 10 ШТ\nГрафа 44"))]) {
    const line = parseDeclarationItems(bad).items[0];
    assert.equal(line.sku, null); assert.equal(line.quantity, null); assert.ok(line.warnings.length);
  }
  assert.ok(parseDeclarationItems(raw.replace("АРТИКУЛ: TEST-A", "АРТИКУЛ: TEST-A АРТИКУЛ: TEST-B")).items[0].warnings.length);
});
test("omitted empty PDF cells do not lose gross weight or customs value", () => {
  const withoutEmptyCells = raw.replace("FI | | 1,200", "FI | 1,200").replace(" | 11000,00\n46", "11000,00\n46");
  const item = parseDeclarationItems(withoutEmptyCells).items[0];
  assert.equal(item.grossKg, 1.2); assert.equal(item.customsValue, 11000); assert.deepEqual(item.warnings, []);
});
test("missing body, duplicate item number, incomplete total and unknown units remain reviewable", () => {
  for (const bad of [raw.replace(body, ""), raw.replace(body, body + body), raw.replace("1 | 1\n12", "2 | 1\n12"), raw.replace("20,00 | 1", "unread | 1"), raw.replace("10 ШТ", "10 ЛИТРОВ")]) {
    assert.ok(parseDeclarationItems(bad).warnings.length);
  }
});
test("invoice layout reads explicit SKU quantity money; validates total and multiplication", () => {
  assert.equal(invoice().items[0].quantity, 10); assert.equal(invoice().total, 20); assert.deepEqual(invoice().warnings, []);
  for (const bad of [invoiceRaw.replace("| 10 |", "| 11 |"), invoiceRaw.replace("| 20,00 | 20,00", "| 21,00 | 21,00"), invoiceRaw.replace("1 | TEST", "2 | TEST"), invoiceRaw.replace("| 0 | 0 |", "| 0 |")]) assert.ok(parseCommodityInvoice(bad)!.warnings.length);
  assert.equal(parseCommodityInvoice("FAKTURA VAT / INVOICE Kod EAN"), null);
});
test("exact SKU, quantity, currency and amount match; equal HS alone cannot match", () => {
  assert.equal(compare().status, "matched");
  const other = shipment(); other[0].sku = "DIFFERENT";
  assert.equal(compare([invoice()], other).status, "review");
  const inv = invoice(); inv.items[0].quantity = 11;
  assert.equal(compare([inv]).status, "different");
  inv.items[0].quantity = 10; inv.currency = "USD";
  assert.equal(compare([inv]).status, "review");
  inv.currency = "EUR"; inv.items[0].amount = 21;
  assert.equal(compare([inv]).status, "different");
});
test("duplicate SKU or multiple invoices, different units and absent data never yield agreement", () => {
  assert.equal(compare([invoice(), invoice()]).status, "review");
  const inv = invoice(); inv.items.push({...inv.items[0],number:2});
  assert.equal(compare([inv]).status, "review");
  const positions = shipment(); positions[0].unit = "box";
  assert.equal(compare([invoice()], positions).status, "review");
  positions[0].unit = "piece"; positions[0].shipped = null;
  assert.equal(compare([invoice()], positions).status, "review");
  assert.equal(compareCommodities([...lines(),...lines()],"EUR",[invoice()],shipment())[0].status,"review");
});
test("split shipment quantities aggregate; original order discrepancy is retained", () => {
  const positions = [{...shipment()[0],ordered:4,confirmed:4,shipped:4},{...shipment()[0],ordered:6,confirmed:6,shipped:6}];
  assert.equal(compare([invoice()],positions).status,"matched");
  positions[1].ordered=7;
  const result=compare([invoice()],positions);
  assert.equal(result.status,"different");
  assert.match(result.shipment,/Заказано: 11 — расхождение/);
  assert.match(result.shipment,/Отгружено: 10 — совпадает/);
});
test("only current accessible document version with active shipment/vehicle link is eligible", () => {
  const source={status:"extracted",document_version_id:"v1"};
  const doc={status:"approved",archived_at:null,current_version:1,versions:[{id:"v1",is_current:true,version_number:1}],links:[{entity_type:"shipment",entity_id:"s1",removed_at:null}]};
  assert.equal(currentCommoditySource(source,doc,"s1",[]),true);
  assert.equal(currentCommoditySource(source,{...doc,current_version:2},"s1",[]),false);
  assert.equal(currentCommoditySource({...source,shipment_transport_id:"cancelled"},doc,"s1",[]),false);
  assert.equal(currentCommoditySource(source,null,"s1",[]),false);
  assert.equal(currentCommoditySource({...source,status:"failed"},doc,"s1",[]),false);
  assert.equal(currentCommoditySource(source,{...doc,status:"rejected"},"s1",[]),false);
  assert.equal(currentCommoditySource(source,{...doc,archived_at:"date"},"s1",[]),false);
  assert.equal(currentCommoditySource(source,{...doc,versions:[{id:"v2",is_current:true,version_number:2}]},"s1",[]),false);
  assert.equal(currentCommoditySource(source,{...doc,links:[{...doc.links[0],removed_at:"date"}]},"s1",[]),false);
  const vehicle={...doc,links:[{...doc.links[0],entity_type:"shipment_transport",entity_id:"t1"}]};
  assert.equal(currentCommoditySource(source,vehicle,"s1",["t1"]),true);
  assert.equal(currentCommoditySource(source,vehicle,"s1",[]),false);
});
test("commodity evidence cannot become confirmed quantities or finance fields", () => {
  const result = extractShipmentFields(invoiceRaw,{hintedKind:"invoice"});
  assert.ok(result.data.commodity_invoice);
  assert.equal(result.data.invoice_items,undefined);
  const safe=sanitizeConfirmedSourceData({commodity_invoice:invoice(),customs_record:parseCustomsForm(raw)});
  assert.deepEqual(safe,{});
});

test("8-digit classification prefix is incomplete evidence, not a conflict or full agreement", () => {
  const positions = shipment(); positions[0].hsCode = "18069019";
  const result = compare([invoice()], positions);
  assert.equal(result.status, "review");
  assert.match(result.shipment, /первые 8 цифр совпадают/);
  assert.doesNotMatch(result.shipment, /ТН ВЭД отличается/);
  positions[0].hsCode = "1806 9019 00";
  assert.equal(compare([invoice()], positions).status, "matched");
  for (const code of ["18063100", "1806901901"]) {
    positions[0].hsCode = code;
    assert.equal(compare([invoice()], positions).status, "different");
  }
  for (const code of [null, "", "1806", "18069019x0"]) {
    positions[0].hsCode = code;
    assert.equal(compare([invoice()], positions).status, "review");
  }
});
