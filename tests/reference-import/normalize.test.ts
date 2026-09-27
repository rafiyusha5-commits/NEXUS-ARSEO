import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NormalizeError,
  barcodeKey,
  cleanText,
  formatTemperatureRange,
  isValidGtin,
  looksCommercial,
  normalizeBarcode,
  normalizeCountry,
  normalizeGtin,
  normalizeHeader,
  normalizeHsCode,
  normalizeLocale,
  normalizeRoles,
  normalizeTemperatureRegime,
  normalizeUom,
  optionalText,
  parseBoolean,
  parseDecimal,
  parseInteger,
  parseTemperature,
} from "../../src/lib/reference-import/normalize.ts";

const money = { scale: 3, label: "вес" };

describe("text", () => {
  it("trims, collapses whitespace and removes invisible characters", () => {
    assert.equal(cleanText("  Конфеты  «Демо»\t200 г ​"), "Конфеты «Демо» 200 г");
    assert.equal(cleanText("﻿DEMO-001\r\n"), "DEMO-001");
    assert.equal(cleanText("é"), "é", "NFC form");
    assert.equal(cleanText(null), "");
    assert.equal(cleanText(undefined), "");
  });

  it("turns Excel numbers and dates into text", () => {
    assert.equal(cleanText(1001), "1001");
    assert.equal(cleanText(new Date("2026-09-27T00:00:00Z")), "2026-09-27");
    assert.equal(cleanText(Number.NaN), "");
  });

  it("returns null for empty optional text and limits the length", () => {
    assert.equal(optionalText("   ", 10, "бренд"), null);
    assert.equal(optionalText(" Demo ", 10, "бренд"), "Demo");
    assert.throws(() => optionalText("x".repeat(11), 10, "бренд"), NormalizeError);
  });

  it("normalises headers written in different ways", () => {
    assert.equal(normalizeHeader("Срок годности, дней"), "срок_годности_дней");
    assert.equal(normalizeHeader(" Name  RU "), "name_ru");
    assert.equal(normalizeHeader("БИН/ИНН"), "бин_инн");
    assert.equal(normalizeHeader("Объём, м3"), "объем_м3");
    assert.equal(normalizeHeader("internal_sku"), "internal_sku");
  });
});

describe("numbers", () => {
  it("parses decimal commas, dots and thousands separators", () => {
    assert.equal(parseDecimal("2,8", money), 2.8);
    assert.equal(parseDecimal("2.8", money), 2.8);
    assert.equal(parseDecimal("1 200,5", money), 1200.5);
    assert.equal(parseDecimal("1 200,5", money), 1200.5);
    assert.equal(parseDecimal("1.200,5", money), 1200.5);
    assert.equal(parseDecimal("1,200.5", money), 1200.5);
    assert.equal(parseDecimal("1.200.300", money), 1200300);
    assert.equal(parseDecimal("1'200", money), 1200);
    assert.equal(parseDecimal(12.25, money), 12.25);
    assert.equal(parseDecimal("", money), null);
    assert.equal(parseDecimal(null, money), null);
  });

  it("rejects text, negatives, extra decimals and huge values", () => {
    assert.throws(() => parseDecimal("12abc", money), /не число/);
    assert.throws(() => parseDecimal("-1", money), /не меньше нуля/);
    assert.throws(() => parseDecimal("0", { ...money, positive: true }), /больше нуля/);
    assert.throws(() => parseDecimal("1,2345", money), /знаков после запятой/);
    assert.throws(() => parseDecimal("1.234,5,6", money), /формат/);
    assert.throws(() => parseDecimal(1e12, { ...money, max: 1e7 }), /слишком большое/);
    assert.throws(() => parseDecimal(Number.POSITIVE_INFINITY, money), /не число/);
  });

  it("keeps floating point noise of spreadsheets within the scale", () => {
    assert.equal(parseDecimal(0.1 + 0.2, { scale: 3, label: "x" }), 0.3);
  });

  it("parses integers within limits", () => {
    assert.equal(parseInteger("365", { min: 1, max: 36500, label: "срок" }), 365);
    assert.equal(parseInteger(" 1 095 ", { min: 1, max: 36500, label: "срок" }), 1095);
    assert.throws(() => parseInteger("365,5", { min: 1, max: 36500, label: "срок" }), /знаков после запятой/);
    assert.throws(() => parseInteger("0", { min: 1, max: 36500, label: "срок" }), /от 1 до 36500/);
  });

  it("parses temperatures with signs and units", () => {
    assert.equal(parseTemperature("-18", "t"), -18);
    assert.equal(parseTemperature("−18 °C", "t"), -18);
    assert.equal(parseTemperature("+2,5", "t"), 2.5);
    assert.equal(parseTemperature(-4, "t"), -4);
    assert.equal(parseTemperature("", "t"), null);
    assert.equal(formatTemperatureRange(2, 6), "+2…+6 °C");
    assert.equal(formatTemperatureRange(-18, null), "от -18 °C");
    assert.equal(formatTemperatureRange(null, 25), "до +25 °C");
    assert.equal(formatTemperatureRange(0, 4.5), "0…+4,5 °C");
    assert.equal(formatTemperatureRange(null, null), null);
    assert.throws(() => formatTemperatureRange(6, 2), /нижняя граница/);
  });
});

describe("flags and dictionaries", () => {
  it("reads yes/no in Russian and English", () => {
    for (const value of ["да", "Да", "yes", "1", 1, true, "+"]) assert.equal(parseBoolean(value, "флаг"), true, String(value));
    for (const value of ["нет", "NO", "0", 0, false, "-"]) assert.equal(parseBoolean(value, "флаг"), false, String(value));
    assert.equal(parseBoolean("", "флаг"), null);
    assert.throws(() => parseBoolean("возможно", "флаг"), /«да» или «нет»/);
  });

  it("maps roles, units, regimes and locales", () => {
    assert.deepEqual(normalizeRoles("Производитель | поставщик", "роли"), ["manufacturer", "supplier"]);
    assert.deepEqual(normalizeRoles(["supplier", "supplier"], "роли"), ["supplier"]);
    assert.throws(() => normalizeRoles("дистрибьютор", "роли"), /неизвестная роль/);
    assert.throws(() => normalizeRoles("", "роли"), /хотя бы одну/);
    assert.equal(normalizeUom("Короб", "u"), "box");
    assert.equal(normalizeUom("шт.", "u"), "piece");
    assert.equal(normalizeUom("поддон", "u"), "pallet");
    assert.throws(() => normalizeUom("мешок", "u"), /неизвестный уровень/);
    assert.equal(normalizeTemperatureRegime("Охлаждённый", "t"), "chilled");
    assert.equal(normalizeTemperatureRegime("frozen", "t"), "frozen");
    assert.equal(normalizeLocale("KZ", "язык"), "kk");
  });

  it("normalises countries and HS codes", () => {
    assert.equal(normalizeCountry(" fi ", "страна"), "FI");
    assert.throws(() => normalizeCountry("Finland", "страна"), /двухбуквенный/);
    assert.equal(normalizeHsCode("1806 90 310 0", "тн"), "1806903100");
    assert.equal(normalizeHsCode("1806.90", "тн"), "180690");
    assert.equal(normalizeHsCode(402100000, "тн"), "0402100000", "Excel lost the leading zero");
    assert.throws(() => normalizeHsCode("402100000", "тн"), /ведущий ноль/);
    assert.throws(() => normalizeHsCode("18A6", "тн"), /только цифры/);
  });

  it("flags column names that look like prices or contract terms", () => {
    for (const name of ["price", "Цена", "purchase_price", "себестоимость", "Маржа, %", "discount", "Условия оплаты", "contract_no", "Валюта"]) {
      assert.equal(looksCommercial(name), true, name);
    }
    for (const name of ["internal_sku", "brand", "temperature_range", "shelf_life_days", "gross_weight_kg"]) {
      assert.equal(looksCommercial(name), false, name);
    }
  });
});

describe("barcodes", () => {
  it("validates GTIN check digits", () => {
    assert.equal(isValidGtin("2000000000015"), true);
    assert.equal(isValidGtin("2000000000016"), false);
    assert.equal(isValidGtin("12000000000012"), true, "GTIN-14");
    assert.equal(isValidGtin("20000000015"), false, "11 digits is not a GTIN length");
    assert.equal(normalizeGtin(" 2000 0000 00015 "), "2000000000015");
    assert.equal(normalizeGtin(2000000000015), "2000000000015", "Excel number");
    assert.throws(() => normalizeGtin("2000000000016"), /контрольной цифрой/);
    assert.throws(() => normalizeGtin(2.5), /не штрихкод/);
    assert.equal(normalizeGtin(""), null);
  });

  it("compares numeric barcodes as GTIN-14", () => {
    assert.equal(barcodeKey("2000000000015"), "02000000000015");
    assert.equal(barcodeKey("02000000000015"), barcodeKey("2000000000015"));
    assert.equal(barcodeKey("ab-12"), "AB-12");
  });

  it("accepts internal barcodes of letters, digits and hyphens", () => {
    assert.equal(normalizeBarcode(" BOX-0001 ", "шк"), "BOX-0001");
    assert.throws(() => normalizeBarcode("12", "шк"), /от 4 до 48/);
    assert.throws(() => normalizeBarcode("КОР-1", "шк"), /латинских/);
  });
});
