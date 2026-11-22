import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Cell } from "../../src/lib/reference-import/normalize.ts";
import { countryCode, customsIssues, matchCustomer, overDistributed, parseCustomsSheet, parseDistributionSheet, parseStickerSheet } from "../../src/lib/shipments/order-workbook-extra.ts";

// Synthetic sheets shaped like the real ones; no real products, prices or companies.
const customs: Cell[][] = [
  ["#", "Артикул", "Описание на русском", "Штрих код", "ТНВЭД", "Цена в инвойсе, EUR", "Сумма заказа, EUR", "Кол-во по инвойсу, шт", "Кол-во по инвойсу, коробов", "Кол-во по инвойсу, паллет", "Вес нетто за ед, кг", "Общий вес НЕТТО, кг", "Общий вес БРУТТО, кг", "Штук в коробке", "Страна происхождения товара"],
  [1, 100001, "Конфеты 1", 4600000000017, 18069019, "€1,70", 100, 1200, 100, 1, 0.15, 180, null, 12, "Finland"],
  [2, 100002, "Конфеты 2", 4600000000024, 18063100, 2.05, 100, 600, 50, 1, 0.15, 90, null, 12, "Финляндия"],
  [3, 100404, "Нет в справочнике", 4600000000048, 18063100, 1, 1, 10, 1, 1, 0.1, 1, null, 10, "Finland"],
];
const stickers: Cell[][] = [
  [null, null, null, null, null, null, null, null, null, null, "размер стикера", "с ЧЗ/без ЧЗ"],
  [null, null, null, null, null, null, null, null, null, null, "52х83", "2 вида без ЧЗ"],
  [null, "Артикул ARSEO", "Заказ №", "Фото продукции", "Наименование (рус)", "Штрих код на товар", "Заказ, шт", "Заказ, кор", "Стикеры Индивидуальные", "Стикеры коробочные"],
  [1, 100001, "AB-50", null, "Конфеты 1", 4600000000017, 1200, 100, 1210, 110],
];
const distribution: Cell[][] = [
  [null, "Вторая машина", null, null, null, null, "ПРИХОД", null, "Продажа в Альфа Ритейл", null, "Алматы", null],
  [null, null, "Артикул завода", "Name (eng)", "Штрих код на товар", "BBD", "Заказ, шт", "Заказ, кор", "Заказ, шт", "Заказ, кор", "Заказ, шт", "Заказ, кор"],
  [1, "AB-40", 226, "Cookies", 4600000000017, "25.02.2027", 7040, 320, 3520, 160, null, null],
  [2, "EF-06", 341, "Soft", 4600000000024, "27.02.2027", 1760, 80, null, null, 1056, 48],
  [3, "EF-06", 375, "Pie", 4600000000031, "23.02.2027", 1000, 50, 600, 30, 600, 30],
];

describe("phase 2 sheets of «Вн расчеты»", () => {
  it("reads the customs sheet and finds differences with the product card and the shipment", () => {
    const lines = parseCustomsSheet(customs);
    assert.deepEqual(lines.map(line => [line.article, line.hsCode, line.price, line.quantity]), [["100001", "18069019", 1.7, 1200], ["100002", "18063100", 2.05, 600], ["100404", "18063100", 1, 10]]);
    const products: Record<string, { id: string; hs_code: string | null; country_of_origin: string | null }> = {
      "100001": { id: "p1", hs_code: "1806 90 190", country_of_origin: "FI" }, "100002": { id: "p2", hs_code: "1806 32 100", country_of_origin: null } };
    const items: Record<string, { quantity: number; price: number | null }> = { p1: { quantity: 1200, price: 1.7 }, p2: { quantity: 500, price: 2.05 } };
    const issues = customsIssues(lines, line => products[line.article] ?? null, id => items[id] ?? null);
    assert.deepEqual(issues.map(issue => `${issue.row}:${issue.field}`), ["3:ТН ВЭД", "3:Страна происхождения", "3:Количество, шт", "4:Товар"]);
  });

  it("knows the countries the sheets write", () => {
    assert.equal(countryCode("Finland"), "FI");
    assert.equal(countryCode("Финляндия"), "FI");
    assert.equal(countryCode("de"), "DE");
    assert.equal(countryCode("Атлантида"), null);
  });

  it("reads sticker counts, size and marking", () => {
    const result = parseStickerSheet(stickers);
    assert.deepEqual(result.lines.map(line => [line.sku, line.unitStickers, line.boxStickers]), [["100001", 1210, 110]]);
    assert.equal(result.size, "52х83");
    assert.equal(result.marking, "2 вида без ЧЗ");
  });

  it("reads the distribution by destination and finds lines given out twice", () => {
    const result = parseDistributionSheet(distribution);
    assert.deepEqual(result.destinations.map(item => [item.kind, item.name]), [["sale", "Альфа Ритейл"], ["warehouse", "Алматы"]]);
    assert.deepEqual(result.lines.map(line => [line.orderCode, line.factorySku, line.received, Object.values(line.quantities)]),
      [["AB-40", "226", 7040, [3520]], ["EF-06", "341", 1760, [1056]], ["EF-06", "375", 1000, [600, 600]]]);
    assert.deepEqual(overDistributed(result).map(line => line.row), [5]);
  });

  it("finds the customer of a «Продажа в …» column by its name", () => {
    const customers = [{ id: "c1", legal_name: "ООО «Альфа Ритейл»", short_name: "Альфа Ритейл" }, { id: "c2", legal_name: "Бета", short_name: null }];
    assert.equal(matchCustomer("альфа ритейл", customers), "c1");
    assert.equal(matchCustomer("ООО Альфа Ритейл", customers), "c1");
    assert.equal(matchCustomer("Гамма", customers), null);
  });
});
