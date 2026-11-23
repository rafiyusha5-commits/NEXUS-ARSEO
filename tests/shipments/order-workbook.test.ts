import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Cell } from "../../src/lib/reference-import/normalize.ts";
import { isOrderWorkbook, matchLine, parseOrderWorkbook, planLines, workbookDate, workbookNumber } from "../../src/lib/shipments/order-workbook.ts";

// Synthetic sheet shaped like «Расчеты»: two header rows, the label row, then order lines. No real products or prices.
const blank = (n: number): Cell[] => Array.from({ length: n }, () => null);
function calculation(): Cell[][] {
  const width = 16;
  const top = blank(width); top[10] = "ПРОДАЖА клиентам"; top[13] = "ЗАКУП у поставщика";
  const dates = blank(width); dates[12] = "Дата выгрузки на РЦ"; dates[15] = "Дата погрузки на заводе";
  const codes = blank(width); codes[12] = "26/01/2027"; codes[15] = "07/12/2026";
  const labels = ["", "Артикул ARSEO", "", "Артикул завода", "Наименование (рус)", "Штрих код на товар", "Вес нетто шт/кг", "", "", "",
    "Цена за ед, тенге", "Заказ, шт", "ОСГ на РЦ, %", "Цена за ед, евро\n(INVOICE)", "Заказ, шт", "ОСГ на заводе, %"];
  return [top, dates, codes, labels,
    [1, 100001, "AB-50", "F-1", "Конфеты 1", "4600000000017", 0.15, null, null, null, 1700, 9999, null, 1.7, 1200, null],
    [2, "100 002", "AB-50", "F-2", "Конфеты 2", "4600000000024", 0.15, null, null, null, 1700, 9999, null, "€2,05", "600,00", null],
    [3, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null],
    [4, 100003, "AB-50", "F-3", "Без заказа", "4600000000031", 0.1, null, null, null, 1, 1, null, 1, 0, null],
  ];
}
const client = [[null, null, "Номер заказа/Order No", "AB-50"], [null, null, "Дата заказа/Date of order", "26.10.2026"],
  [null, null, "Номер контракта/Contract number", "SYN-1"], [null, null, "Дата контракта/date of contract", "02.09.2022"]];

describe("«Вн расчеты» workbook", () => {
  it("reads the purchase lines, not the sales columns", () => {
    const workbook = parseOrderWorkbook(calculation(), client);
    assert.deepEqual(workbook.lines.map(line => [line.sku, line.factorySku, line.ean, line.quantity, line.price]),
      [["100001", "F-1", "4600000000017", 1200, 1.7], ["100002", "F-2", "4600000000024", 600, 2.05]]);
    assert.equal(workbook.loadingDate, "2026-12-07");
    assert.equal(workbook.unloadingDate, "2027-01-26");
    assert.deepEqual(workbook.clientOrder, { number: "AB-50", date: "2026-10-26", contract: "SYN-1", contractDate: "2022-09-02" });
  });

  it("refuses a sheet without the purchase columns", () => {
    const rows = calculation(); rows[3][13] = "Цена";
    assert.throws(() => parseOrderWorkbook(rows), /столбцы закупа/);
    assert.throws(() => parseOrderWorkbook([["нет заголовков"]]), /Артикул ARSEO/);
  });

  it("reads numbers and dates as the sheet writes them", () => {
    assert.equal(workbookNumber("38 841,60"), 38841.6);
    assert.equal(workbookNumber("€1,70"), 1.7);
    assert.equal(workbookNumber("-"), null);
    assert.equal(workbookDate("31/02/2026"), null);
    assert.equal(workbookDate("19.04.1899"), null);
  });

  it("matches products by ARSEO article, factory article, then EAN", () => {
    const products = [{ id: "p1", sku: "100001", supplierSkus: [], eans: [] }, { id: "p2", sku: "X", supplierSkus: ["F-2"], eans: [] },
      { id: "p3", sku: "Y", supplierSkus: [], eans: ["4600000000031"] }, { id: "p4", sku: "Z", supplierSkus: [], eans: ["4600000000031"] }];
    const line = { row: 1, sku: "", factorySku: "", ean: "", name: "", quantity: 1, price: null };
    assert.deepEqual(matchLine({ ...line, sku: "100001" }, products), { id: "p1", by: "артикул ARSEO" });
    assert.deepEqual(matchLine({ ...line, sku: "100002", factorySku: "F-2" }, products), { id: "p2", by: "артикул завода" });
    assert.deepEqual(matchLine({ ...line, ean: "4600000000031" }, products), { reason: "штрихкод подходит нескольким товарам" });
    assert.deepEqual(matchLine({ ...line, sku: "404" }, products), { reason: "товар не найден в справочнике" });
  });

  it("plans additions, changes and lines it leaves to the vehicles", () => {
    const [a, b] = parseOrderWorkbook(calculation()).lines;
    const products = [{ id: "p1", sku: "100001", supplierSkus: [], eans: [] }, { id: "p2", sku: "100002", supplierSkus: [], eans: [] }, { id: "p9", sku: "9", supplierSkus: [], eans: [] }];
    let result = planLines([a, b], products, []);
    assert.deepEqual(result.plans.map(plan => plan.kind), ["add", "add"]);
    result = planLines([a, b], products, [{ id: "i1", product_id: "p1", quantity: 1200, price: 1.7, transport: null },
      { id: "i2", product_id: "p2", quantity: 500, price: 2.05, transport: null }, { id: "i9", product_id: "p9", quantity: 5, price: null, transport: null }]);
    assert.deepEqual(result.plans.map(plan => plan.kind), ["same", "update"]);
    assert.deepEqual(result.notInWorkbook.map(item => item.id), ["i9"]);
    result = planLines([a], products, [{ id: "i1", product_id: "p1", quantity: 700, price: 1.7, transport: "t1" }, { id: "i3", product_id: "p1", quantity: 500, price: 1.7, transport: "t2" }]);
    assert.deepEqual(result.plans.map(plan => plan.kind), ["split"]);
  });

  it("finds the workbook file of a folder, not its copy", () => {
    const sheet = "application/vnd.google-apps.spreadsheet";
    assert.equal(isOrderWorkbook("Вн расчеты AB-50 Nordic", sheet), true);
    assert.equal(isOrderWorkbook("Копия для расчетов Вн расчеты AB-50", sheet), false);
    assert.equal(isOrderWorkbook("Вн расчеты AB-50.xlsx", "application/pdf"), false);
    // The words may stand anywhere in the name, with or without a dot, in any case.
    assert.equal(isOrderWorkbook("AB-46 Вн расчеты паста", sheet), true);
    assert.equal(isOrderWorkbook("Паста AB-46 (вн. расчёты)", sheet), true);
    assert.equal(isOrderWorkbook("AB-46 ВН.РАСЧЕТЫ", sheet), true);
    assert.equal(isOrderWorkbook("AB-46 Вн расчеты — копия", sheet), false);
    assert.equal(isOrderWorkbook("Свн расчеты", sheet), false);
    assert.equal(isOrderWorkbook("Внешние расчеты AB-46", sheet), false);
  });
});
