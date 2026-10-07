// Builds the committed test fixture from the confidential reference workbook:
//   node scripts/build-export-fixture.ts "<path>/Отгрузка заказ HS-41.1 Fazer.xlsx" tests/fixtures/export-workbook/reference-template.xlsx
// Structure, formulas, merges, print setup and the CMR stamp circle are kept; every commercial value
// (parties, requisites, prices, quantities, barcodes, driver, vehicle, addresses) is replaced by invented data.
// The script lists cells by address only, so it contains no real data itself.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { XlsxWorkbook } from "../src/lib/export-workbook/xlsx-package.ts";

const [source, target] = process.argv.slice(2);
if (!source || !target) { console.error("Usage: node scripts/build-export-fixture.ts <reference.xlsx> <fixture.xlsx>"); process.exit(1); }

const workbook = XlsxWorkbook.load(new Uint8Array(readFileSync(source)));
const text = (sheet: string, cell: string, value: string) => workbook.sheet(sheet).set(cell, value, { keepEmptyText: true });
const number = (sheet: string, cell: string, value: number) => workbook.sheet(sheet).set(cell, value);

// «данные» — input block
const input: Record<string, string | number | Date> = {
  C2: "TEST-1", C3: new Date(Date.UTC(2030, 0, 10)) as never, C4: new Date(Date.UTC(2030, 0, 20)) as never, C5: "Тестов Тест Тестович", C6: "уд/личн: 000000000 выд 01.01.2020 тестовый орган",
  C7: "000TST00", C8: "TESTTRUCK", C9: "00TRL00", C10: "TESTTRAILER", C11: "ТОО «Тест-Логистика»", C12: 1, C13: "г. Тестоград", C14: "Тестландия", C15: "тестовые кондитерские изделия", C16: 3,
  C17: "+10 - +15", C18: "00000001, 00000002", C19: "Тестландия, Тестовая область, г. Тестоград, ул. Складская, 1", C20: 1, C21: 1, C22: 1, C24: "0000000001, 0000000002", C25: "DAP Тестоград, Договор № T-000 от 1/01/2020",
  C27: 1, C28: "г. Тестоград, ул. Заводская, 2",
};
for (const [cell, value] of Object.entries(input)) {
  if (value instanceof Date) workbook.sheet("данные").set(cell, value);
  else if (typeof value === "number") number("данные", cell, value);
  else text("данные", cell, value);
}

// «списки» — delivery points
for (const [cell, value] of Object.entries({ C2: "Город-А", D2: "Тестландия, г. Город-А, ул. Тестовая, 1", E2: "ПН-ПТ с 9 до 18", C3: "Город-Б", D3: "Тестландия, г. Город-Б, ул. Тестовая, 2", E3: "ПН-ПТ с 9 до 18", C4: "Город-В", D4: "Город-В, ул. Тестовая, 3", D5: "Тестландия, Тестовая область, г. Тестоград, ул. Складская, 1" })) text("списки", cell, value);

// «для Диляры» — contract line and the product table
text("для Диляры", "C5", "№ T-000 от 1/01/2020"); text("для Диляры", "C7", "ТОО «Тест-Продавец» и ООО «Тест-Покупатель»");
const products = [
  { hs: "0000000001", name: "Тестовый товар А 100г", sku: "T-001", qty: 1000, price: 100, net: 0.1, expiry: new Date(Date.UTC(2031, 0, 1)) },
  { hs: "", name: "", sku: "", qty: 200, price: 100, net: 0.1, expiry: new Date(Date.UTC(2031, 1, 1)) },
  { hs: "0000000002", name: "Тестовый товар Б 200г", sku: "T-002", qty: 500, price: 200, net: 0.2, expiry: new Date(Date.UTC(2031, 2, 1)) },
  { hs: "0000000002", name: "Тестовый товар В 200г", sku: "T-003", qty: 500, price: 200, net: 0.2, expiry: new Date(Date.UTC(2031, 3, 1)) },
  { hs: "0000000002", name: "Тестовый товар Г 200г", sku: "T-004", qty: 500, price: 200, net: 0.2, expiry: new Date(Date.UTC(2031, 4, 1)) },
  { hs: "0000000002", name: "Тестовый товар Д 200г", sku: "T-005", qty: 500, price: 200, net: 0.2, expiry: new Date(Date.UTC(2031, 5, 1)) },
  { hs: "0000000001", name: "Тестовый товар Е 150г", sku: "T-006", qty: 500, price: 150, net: 0.15, expiry: new Date(Date.UTC(2031, 6, 1)) },
];
const lines = workbook.sheet("для Диляры");
products.forEach((product, index) => {
  const row = 17 + index;
  if (product.hs) lines.set(`B${row}`, product.hs);
  if (product.name) lines.set(`C${row}`, product.name);
  if (product.sku) lines.set(`H${row}`, product.sku);
  lines.set(`E${row}`, product.qty); lines.set(`F${row}`, product.price); lines.set(`I${row}`, product.expiry);
  lines.setFormula(`D${row}`, `E${row}*${product.net}`);
});

// «упаков.лист» — table and the requisite blocks
const packing = workbook.sheet("упаков.лист");
text("упаков.лист", "K4", "к Контракту № T-000 от 1/01/2020"); text("упаков.лист", "K6", "ТОО «Тест-Продавец» и ООО «Тест-Покупатель»");
const rows: Array<{ barcode: string; pieces: number | null; net: number; box: number; pallets: number; gross: number }> = [
  { barcode: "0000000000001", pieces: 1200, net: 0.1, box: 10, pallets: 1, gross: 150 },
  { barcode: "0000000000002", pieces: null, net: 0.2, box: 20, pallets: 1, gross: 120 },
  { barcode: "0000000000003", pieces: null, net: 0.2, box: 20, pallets: 1, gross: 120 },
  { barcode: "0000000000004", pieces: null, net: 0.2, box: 20, pallets: 1, gross: 120 },
  { barcode: "0000000000005", pieces: null, net: 0.2, box: 20, pallets: 1, gross: 120 },
  { barcode: "0000000000006", pieces: null, net: 0.15, box: 10, pallets: 1, gross: 80 },
];
rows.forEach((row, index) => {
  const r = 12 + index;
  packing.set(`B${r}`, "Тестландия"); packing.set(`C${r}`, row.barcode); packing.set(`I${r}`, row.pallets); packing.set(`J${r}`, row.gross);
  if (row.pieces !== null) packing.set(`E${r}`, row.pieces);
  packing.setFormula(`F${r}`, `E${r}*${row.net}`); packing.setFormula(`H${r}`, `E${r}/${row.box}`);
});
text("упаков.лист", "A23", "ООО «Тест-Покупатель»");
text("упаков.лист", "A24", "Адрес доставки:\nТестландия, Тестовая область, г. Тестоград, ул. Складская, 1\n\n");
text("упаков.лист", "A25", "ИНН 0000000000"); text("упаков.лист", "A26", "КПП 000000000");
text("упаков.лист", "F23", "ТОО «Тест-Продавец»");
text("упаков.лист", "F24", "Адрес для корреспонденции:\nТестландия, 000000, г. Тестоград, пр. Тестовый 1\nТОО «Тест-Продавец»\nт.+0 000 000 0000");
text("упаков.лист", "F25", "БИН 000000000000"); text("упаков.лист", "F26", "+0 000 000 0000 Тест");
text("упаков.лист", "J23", "Тест-Банк"); text("упаков.лист", "J24", "Тестоград, Тестландия\nСВИФТ TESTBANK\nБИК 000000000\nР/с 00000000000000000000\n\nК/с 00000000000000000000");
text("упаков.лист", "J25", "ИНН 0000000000\n"); text("упаков.лист", "J26", "КПП 000000000");

// CMR / ТТН / «фура, водила» / «Инструкция»
text("CMR", "A3", "Товарищество с ограниченной ответственностью «Тест-Продавец»"); text("CMR", "A4", "Тестландия, г. Тестоград, ул. Заводская, 2"); text("CMR", "A5", "Тестландия");
text("CMR", "A9", "ООО «Тест-Покупатель»"); text("CMR", "A10", "Тестландия, г. Тестоград, ул. Офисная, 3"); text("CMR", "A11", "помещение 1"); text("CMR", "A12", "ИНН 0000000000"); text("CMR", "B16", "Тестландия");
text("ТТН", "C11", "ТОО «Тест-Продавец»"); text("ТТН", "B13", "ТОО «Тест-Продавец» - г. Тестоград, ул. Заводская, 2"); text("ТТН", "B15", "ООО «Тест-Покупатель»"); text("ТТН", "B36", "Тестов Т.Т., директор \nФИО и должность ");
text("фура, водила", "C5", "№ T-000 от 1/01/2020"); text("фура, водила", "C7", "ТОО «Тест-Продавец» и ООО «Тест-Покупатель»");
text("Инструкция", "B1", "Сообщить отправителю о прибытии под разгрузку на склад получателя"); text("Инструкция", "B2", "Сфотографировать груз СРАЗУ при открытии фуры ДО выгрузки и выслать отправителю");
text("Инструкция", "C17", "ООО «Тест-Покупатель»"); text("Инструкция", "C18", "ТОО «Тест-Продавец»"); text("Инструкция", "C19", "8 000 000 0000 Тест"); text("Инструкция", "C20", "8 000 000 0001 Тест");

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, workbook.toBytes());
console.log(`Fixture written: ${target}`);
