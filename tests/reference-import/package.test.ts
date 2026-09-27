import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { MAX_PRODUCTS, normalizePackage } from "../../src/lib/reference-import/package.ts";
import { hasChanges, hasProblems, parseReport, sortReportItems } from "../../src/lib/reference-import/report.ts";
import { buildPackageFromTables, parseCsv, readTable } from "../../src/lib/reference-import/tables.ts";
import { CSV_TEMPLATES, JSON_TEMPLATE, TEMPLATE_KINDS, csvTemplate } from "../../src/lib/reference-import/templates.ts";

const pkg = (products: unknown[], counterparties: unknown[] = []) =>
  ({ format: "nexus-reference-import", version: 1, counterparties, products });

describe("CSV parsing", () => {
  it("detects the semicolon delimiter and keeps decimal commas", () => {
    assert.deepEqual(parseCsv("﻿a;b;c\r\n1;2,5;\"x;y\"\r\n"), [["a", "b", "c"], ["1", "2,5", "x;y"]]);
  });

  it("parses comma and tab separated files with quotes", () => {
    assert.deepEqual(parseCsv('a,b\n"he said ""hi""",2\n'), [["a", "b"], ['he said "hi"', "2"]]);
    assert.deepEqual(parseCsv("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv('a;b\n"line 1\nline 2";2'), [["a", "b"], ["line 1\nline 2", "2"]]);
  });
});

describe("tables", () => {
  it("recognises each template and reads it without problems", () => {
    for (const kind of TEMPLATE_KINDS) {
      const issues: never[] = [];
      const table = readTable({ source: kind, rows: parseCsv(csvTemplate(kind)) }, issues);
      assert.equal(table?.kind, kind);
      assert.deepEqual(issues, [], kind);
    }
  });

  it("builds one package from all templates", () => {
    const { pkg: built, issues } = buildPackageFromTables(
      TEMPLATE_KINDS.map((kind) => ({ source: kind, rows: parseCsv(csvTemplate(kind)) })),
    );
    assert.deepEqual(issues, []);
    assert.equal(built.counterparties.length, 2);
    assert.deepEqual(built.counterparties[0].roles, ["manufacturer", "supplier"]);
    const [product] = built.products;
    assert.equal(built.products.length, 1);
    assert.equal(product.row, 2);
    assert.deepEqual(product.name, { ru: "Демо конфеты 200 г", en: "Demo sweets 200 g" });
    assert.equal(product.hs_code, "1806903100");
    assert.equal(product.temperature_range, "+5…+25 °C");
    assert.equal(product.requires_sticker, true);
    assert.deepEqual(product.nutrition_facts, { basis: "100g", energy_kcal: 530, protein_g: 6.5, fat_g: 30, carbohydrates_g: 58, salt_g: 0.1 });
    assert.deepEqual(product.identifiers.map((item) => item.type), ["gtin", "box_barcode", "supplier_sku", "supplier_sku"]);
    assert.equal(product.identifiers[2].counterparty, "demo-dist", "supplier column goes to the supplier article");
    assert.deepEqual(product.packaging.map((level) => [level.uom, level.units_per_parent]), [["piece", 1], ["box", 12], ["pallet", 60]]);
    assert.equal(product.packaging[1].gross_weight_kg, 2.8);
  });

  it("accepts Russian headers", () => {
    const { pkg: built, issues } = buildPackageFromTables([{ source: "товары.csv", rows: [
      ["Внутренний артикул", "Наименование", "Производитель", "Срок годности, дней", "ТН ВЭД", "Стикеровка"],
      ["SKU-1", "Товар", "Demo", "180", "0402 10", "да"],
    ] }]);
    assert.deepEqual(issues, []);
    assert.deepEqual(built.products[0], {
      row: 2, internal_sku: "SKU-1", name: { ru: "Товар" }, manufacturer: "Demo", shelf_life_days: 180, hs_code: "040210",
      requires_sticker: true, identifiers: [], packaging: [],
    });
  });

  it("rejects price and unknown columns instead of ignoring them", () => {
    const { issues } = buildPackageFromTables([{ source: "товары.csv", rows: [
      ["internal_sku", "name_ru", "Цена закупки", "Комментарий"],
      ["SKU-1", "Товар", "100", "x"],
    ] }]);
    assert.equal(issues.length, 2);
    assert.match(issues[0].message, /похожа на цену/);
    assert.match(issues[1].message, /Неизвестная колонка «Комментарий»/);
  });

  it("reports row-level problems with the sheet row number", () => {
    const { pkg: built, issues } = buildPackageFromTables([{ source: "товары.csv", rows: [
      ["internal_sku", "name_ru", "gtin", "country_of_origin"],
      ["SKU-1", "Товар", "2000000000015", "FI"],
      [],
      ["SKU-2", "Товар", "2000000000016", "Finland"],
    ] }]);
    assert.equal(built.products.length, 1);
    assert.deepEqual(issues.map((issue) => issue.row), [4, 4]);
    assert.match(issues.map((issue) => issue.message).join(" "), /контрольной цифрой.*двухбуквенный|двухбуквенный.*контрольной цифрой/);
  });

  it("attaches identifier and packaging rows to products, creating update-only products", () => {
    const { pkg: built, issues } = buildPackageFromTables([
      { source: "ids.csv", rows: [["internal_sku", "identifier_type", "value", "counterparty"], ["OLD-1", "supplier_sku", "A-1", "Demo"]] },
      { source: "pack.csv", rows: [["internal_sku", "uom", "units_per_parent"], ["OLD-1", "короб", "6"], ["", "box", "6"]] },
    ]);
    assert.equal(issues.length, 1, "the row without SKU");
    assert.deepEqual(built.products, [{
      row: 2, internal_sku: "OLD-1",
      identifiers: [{ type: "supplier_sku", value: "A-1", counterparty: "Demo" }],
      packaging: [{ uom: "box", units_per_parent: 6 }],
    }]);
  });

  it("requires a supplier article together with the supplier", () => {
    const { issues } = buildPackageFromTables([{ source: "t.csv", rows: [
      ["internal_sku", "name_ru", "supplier"], ["SKU-1", "Товар", "Demo"],
    ] }]);
    assert.match(issues[0].message, /вместе с артикулом поставщика/);
  });
});

describe("JSON packages", () => {
  it("accepts the documented example unchanged and is idempotent", () => {
    const example = JSON.parse(readFileSync(new URL("../../docs/reference-import.example.json", import.meta.url), "utf8"));
    assert.deepEqual(example, JSON.parse(JSON.stringify(JSON_TEMPLATE)), "docs example matches the downloadable template");
    const first = normalizePackage(example);
    assert.deepEqual(first.issues, []);
    assert.deepEqual(first.pkg, example);
    assert.deepEqual(normalizePackage(JSON.parse(JSON.stringify(first.pkg))).pkg, first.pkg);
  });

  it("normalises loosely typed values", () => {
    const { pkg: built, issues } = normalizePackage(pkg([{
      internal_sku: " SKU-1 ", name: "Товар", shelf_life_days: "365", requires_marking: "нет",
      temperature_min_c: "-18", nutrition_facts: { fat_g: "3,5" },
      identifiers: [{ type: "gtin", value: 2000000000015 }], packaging: [{ uom: "Короб", units_per_parent: "12" }],
    }]));
    assert.deepEqual(issues, []);
    assert.deepEqual(built.products[0], {
      row: 1, internal_sku: "SKU-1", name: { ru: "Товар" }, shelf_life_days: 365, requires_marking: false,
      temperature_range: "от -18 °C", nutrition_facts: { fat_g: 3.5 },
      identifiers: [{ type: "gtin", value: "2000000000015" }], packaging: [{ uom: "box", units_per_parent: 12 }],
    });
  });

  it("rejects commercial fields, unknown fields and a wrong envelope", () => {
    const { issues } = normalizePackage(pkg([{ internal_sku: "SKU-1", base_purchase_price: 10, margin: 5, colour: "red" }]));
    assert.equal(issues.length, 3);
    assert.match(issues[0].message, /base_purchase_price.*похоже на цену/);
    assert.match(issues[2].message, /неизвестное поле «colour»/);
    assert.match(normalizePackage({ format: "other", version: 1, products: [{}] }).issues[0].message, /format/);
    assert.match(normalizePackage([]).issues[0].message, /JSON-объект/);
    assert.match(normalizePackage(pkg([])).issues[0].message, /ни контрагентов, ни товаров/);
  });

  it("checks identifiers, packaging and nutrition", () => {
    const { issues } = normalizePackage(pkg([{
      internal_sku: "SKU-1",
      nutrition_facts: { basis: "100g", fat_g: 120 },
      identifiers: [{ type: "supplier_sku", value: "A-1" }, { type: "gtin", value: "2000000000015", counterparty: "X" }, { type: "ean", value: "1" }],
      packaging: [{ uom: "box", gross_weight_kg: 1, net_weight_kg: 2 }, { units_per_parent: 2 }],
    }]));
    const text = issues.map((issue) => issue.message).join("\n");
    assert.match(text, /fat_g больше 100 г/);
    assert.match(text, /укажите поставщика или производителя/);
    assert.match(text, /у штрихкода не указывается контрагент/);
    assert.match(text, /тип — gtin/);
    assert.match(text, /нетто больше веса брутто/);
    assert.match(text, /не указан уровень/);
  });

  it("limits the package size", () => {
    const many = Array.from({ length: MAX_PRODUCTS + 1 }, (_, index) => ({ internal_sku: `SKU-${index}` }));
    assert.match(normalizePackage(pkg(many)).issues.at(-1)?.message ?? "", /Разделите файл/);
  });
});

describe("report", () => {
  const raw = {
    summary: { create: 1, update: 0, unchanged: 1, conflict: 1, error: 0 },
    items: [
      { entity: "product", row: 2, key: "SKU-1", status: "unchanged", changes: [], message: null },
      { entity: "identifier", row: 3, key: "SKU-2 · gtin 2000000000015", status: "conflict", changes: [], message: "Штрихкод уже принадлежит товару SKU-1" },
      { entity: "product", row: 3, key: "SKU-2", status: "create", changes: [], message: null },
      { entity: "hacker", row: 1, key: "x", status: "create" },
    ],
    dry_run: true,
    applied: false,
  };

  it("parses the RPC result and drops unknown entries", () => {
    const report = parseReport(raw);
    assert.ok(report);
    assert.equal(report.items.length, 3);
    assert.equal(report.dryRun, true);
    assert.equal(hasProblems(report), true);
    assert.equal(hasChanges(report), true);
    assert.deepEqual(sortReportItems(report.items).map((item) => item.status), ["conflict", "create", "unchanged"]);
    assert.equal(parseReport({ items: [] }), null);
  });
});

describe("templates", () => {
  it("contain no price-like columns", () => {
    for (const kind of TEMPLATE_KINDS) {
      assert.ok(!CSV_TEMPLATES[kind][0].some((header) => /price|cost|margin|цен/i.test(header)), kind);
    }
  });
});
