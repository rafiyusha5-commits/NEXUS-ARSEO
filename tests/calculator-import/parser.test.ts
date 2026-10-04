import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCalculatorPackage, isCalculatorSheet } from "../../src/lib/calculator-import/parser.ts";
import type { Cell } from "../../src/lib/reference-import/normalize.ts";

function sheet() {
  const width = 31;
  const rows: Cell[][] = Array.from({ length: 6 }, () => Array(width).fill(null));
  const header = (column: number, number: Cell, block: Cell, en: Cell, ru: Cell) => {
    rows[0][column] = number;
    rows[2][column] = block;
    rows[3][column] = en;
    rows[4][column] = ru;
  };
  header(0, 0, null, null, "Активный асс-т  ARSEO");
  header(1, 1, null, null, "Артикул ARSEO");
  header(2, 2, null, "Name (rus)", "Наименование (рус)");
  header(3, 3, null, "Producer article", "Артикул производителя");
  header(4, 4, null, "Name (eng)", "Наименование (англ)");
  header(5, 5, "Individual packing data // Информация по индивидуальной упаковке", "Packing", "Вид упаковки");
  header(6, 6, null, "Individual Barcode", "Штрих код");
  header(7, 7, null, "Net weight, kg", "Вес нетто ед, кг");
  header(8, 8, null, "Gross weight, kg", "Вес брутто ед, кг");
  header(9, 9, null, null, "Срок годности, дни");
  header(10, 10, null, null, "Бренд");
  header(11, 11, "Transportation box data // Информация по транспортной упаковке", "Pcs/box", "Штук товара в коробке");
  header(12, 12, null, "Box barcode", "Штрих код короба");
  header(13, 13, null, "Gross weight, kg", "Вес брутто, кг");
  header(14, 14, null, null, "Длина кор, мм");
  header(15, 15, "Информация о закупе", null, "Страна происхождения товара");
  header(16, 16, null, null, "Цена за единицу");
  header(17, 17, "Транспортировка и растаможка", null, "ТНВЭД");
  header(18, 18, null, null, "НДС на штуку");
  header(19, 19, "Подготовка и доставыка товара", null, "Прочие на единицу\n(брокер, пошлина, банк.комиссия, СВХ)");
  header(20, 20, null, null, "Доставка мелкими партиями до клиента\n(Доставка по КЗ+разгрузка+до ТТ+хранение)");
  header(21, null, null, null, "Производитель");
  header(22, null, null, null, "Категория товаров");
  header(23, null, null, null, "Наименование (каз)");
  header(24, null, "Europallet data // Информация по европаллете", "Pcs/pallet", "Штук на паллете");
  header(25, null, null, null, "Можно стоппировать");
  header(26, null, "Truckload data // Информация по загрузке в фуру", "Pcs/truck", "Количество штук в фуре");
  header(27, null, null, null, "Вес брутто с учетом веса паллет, кг");
  rows[5] = [1, "SKU-1", "Товар", "M-1", "Product", "пачка", "1234-AB", 0.2, 0.22, 365, "Dumle", 12, "5678-CD", 2.8, 300, "Finland", 1.25, "180690", 0.16, 3, 4, "Froosh AB", "Конфеты", "Тауар", 80, "Да", 30, 12000];
  return rows;
}

describe("master calculator import", () => {
  it("recognises both spellings of the calculation sheet", () => {
    assert.equal(isCalculatorSheet("Расчёты"), true);
    assert.equal(isCalculatorSheet(" расчеты "), true);
    assert.equal(isCalculatorSheet("data"), false);
  });

  it("treats rows 1 and 2 as metadata and maps rows 3-5 by names", () => {
    const { pkg, issues } = buildCalculatorPackage(sheet(), "calculator.xlsx", "расчеты");
    assert.deepEqual(issues, []);
    assert.equal(pkg.reference.products.length, 1);
    const product = pkg.reference.products[0];
    assert.equal(product.internal_sku, "SKU-1");
    assert.equal(product.manufacturer, "Fazer Confectionary Ltd", "Froosh products belong to Fazer");
    assert.equal(product.country_of_origin, "FI");
    assert.deepEqual(product.name, { ru: "Товар", en: "Product", kk: "Тауар" });
    assert.equal(product.identifiers.find((item) => item.type === "supplier_sku")?.counterparty, "Fazer Confectionary Ltd");
    assert.deepEqual(product.packaging.map((item) => [item.uom, item.units_per_parent]), [["piece", 1], ["box", 12], ["pallet", 80], ["truck", 30]]);
    assert.equal(pkg.source.columns.find((column) => column.position === 25)?.field_ru, "Количество коробов на паллете");
    assert.equal(pkg.source.columns.find((column) => column.position === 25)?.field_en, "Boxes per pallet");
    assert.equal(pkg.source.columns.find((column) => column.position === 27)?.field_ru, "Количество паллет в машине");
    assert.equal(pkg.source.columns.find((column) => column.position === 27)?.field_en, "Pallets per truck");
    assert.equal(pkg.source.columns.find((column) => column.key === "product.internal_sku")?.source_number, "1");
    assert.equal(pkg.source.rows[0].category, "Конфеты");
    assert.equal(pkg.source.rows[0].confidential_data["source.информация_о_закупе.цена_за_единицу"], 1.25);
    assert.equal(pkg.source.rows[0].catalog_data["product.category"], "Конфеты");
  });

  it("reports incomplete product rows before any database write", () => {
    const rows = sheet();
    rows.push([1, "SKU-2", "Без завода"]);
    const { pkg, issues } = buildCalculatorPackage(rows, "calculator.xlsx", "расчеты");
    assert.match(issues.map((item) => item.message).join("\n"), /производитель/);
    assert.deepEqual(pkg.reference.products.map((item) => item.internal_sku), ["SKU-1"]);
    assert.deepEqual(pkg.source.rows.map((item) => item.internal_sku), ["SKU-1"]);
  });

  it("isolates every invalid product row while keeping valid products importable", () => {
    const rows = sheet();
    const invalidSku = [...rows[5]];
    invalidSku[1] = "X".repeat(65);
    invalidSku[2] = "Слишком длинный артикул";
    rows.splice(5, 0, invalidSku);
    const missingOrigin = [...rows[5]];
    missingOrigin[1] = "SKU-3";
    missingOrigin[2] = "Неизвестная страна";
    missingOrigin[15] = "";
    missingOrigin[21] = "Unknown Factory";
    rows.push(missingOrigin);

    const { pkg, issues } = buildCalculatorPackage(rows, "calculator.xlsx", "расчеты");

    assert.deepEqual(issues.map((issue) => issue.row), [8, 6]);
    assert.deepEqual(pkg.reference.products.map((item) => item.internal_sku), ["SKU-1"]);
    assert.deepEqual(pkg.source.rows.map((item) => item.internal_sku), ["SKU-1"]);
    assert.deepEqual(pkg.reference.counterparties.map((item) => item.legal_name), ["Fazer Confectionary Ltd"]);
  });

  it("skips every product row that shares a barcode with another product", () => {
    const rows = sheet();
    const duplicate = [...rows[5]];
    duplicate[1] = "SKU-2";
    duplicate[2] = "Другой товар";
    duplicate[3] = "M-2";
    rows.push(duplicate);

    const { pkg, issues } = buildCalculatorPackage(rows, "calculator.xlsx", "расчеты");

    assert.deepEqual(pkg.reference.products, []);
    assert.deepEqual(pkg.source.rows, []);
    assert.deepEqual(issues.map((issue) => issue.row), [6, 7, 6, 7]);
    assert.ok(issues.every((issue) => /штрихкод/.test(issue.message)));
  });

  it("treats Google Sheets formula errors as a missing manufacturer", () => {
    const rows = sheet();
    rows[5][21] = "#N/A (Did not find value in XLOOKUP evaluation.)";

    const { pkg, issues } = buildCalculatorPackage(rows, "calculator.xlsx", "расчеты");

    assert.deepEqual(pkg.reference.products, []);
    assert.deepEqual(pkg.reference.counterparties, []);
    assert.match(issues[0]?.message ?? "", /производитель/);
  });
});

