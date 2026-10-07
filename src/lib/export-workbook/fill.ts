// Fills a copy of the reference workbook from an ExportModel. The template itself is never
// modified: the caller passes bytes and gets a new package back.

import { XlsxWorkbook, type XlsxSheet } from "./xlsx-package.ts";
import { INPUT_FIELDS, SHEETS, formatDateForCell } from "./field-map.ts";
import { formatRuDate, type ExportModel } from "./model.ts";
import { parseRange, translateFormula } from "./refs.ts";

// `styleRow` is a regular middle row of the sample table: the first and last rows have their own
// borders, so rows are added/removed just before the last one and new rows copy the regular style.
const LINES = { first: 17, capacity: 7, total: 24, lastColumn: "I", styleRow: 22 };
const PACKING = { first: 12, capacity: 6, total: 18, gFormulaCell: "G12", kFormulaCell: "K12", styleRow: 15 };
const LINES_REF = `'${SHEETS.lines}'`;

export class TemplateLayoutError extends Error {}

const nf = (value: number) => String(Number(value.toFixed(6)));
const COLUMNS = (from: string, to: string) => Array.from({ length: to.charCodeAt(0) - from.charCodeAt(0) + 1 }, (_, index) => String.fromCharCode(from.charCodeAt(0) + index));

/** Guards against filling a book that is not the approved reference layout (wrong or edited template). */
export function assertReferenceLayout(workbook: XlsxWorkbook) {
  for (const name of Object.values(SHEETS)) if (!workbook.hasSheet(name)) throw new TemplateLayoutError(`В книге нет обязательного листа «${name}»: это не эталон экспортной отгрузки ARSEO`);
  const input = workbook.sheet(SHEETS.input), lines = workbook.sheet(SHEETS.lines), packing = workbook.sheet(SHEETS.packing);
  const checks: Array<[boolean, string]> = [
    [input.raw("B2") === "Заказ №" && input.raw("B28") === "Адрес погрузки", "«данные»: сдвинуты входные ячейки B2:B28"],
    [lines.raw("B24") === "ИТОГО" && lines.formula("D24") === `SUM(D${LINES.first}:D${LINES.total - 1})`, "«для Диляры»: изменена строка ИТОГО или диапазон сумм"],
    [lines.raw("A16") === "№" && lines.raw("C16") === "НАИМЕНОВАНИЕ", "«для Диляры»: изменена шапка таблицы товаров"],
    [packing.raw("A9") === "№" && packing.formula("E18") === `SUM(E${PACKING.first}:E${PACKING.total - 1})`, "«упаков.лист»: изменена шапка или строка итогов"],
  ];
  for (const [ok, message] of checks) if (!ok) throw new TemplateLayoutError(`Структура книги отличается от эталона — ${message}`);
}

function setInput(sheet: XlsxSheet, cell: string, kind: string, value: string | number | null) {
  if (value === null) { sheet.set(cell, "", { keepEmptyText: true }); return; }
  if (kind === "date" && typeof value === "string") { const date = formatDateForCell(value); sheet.set(cell, date ?? value); return; }
  if (kind === "number" && typeof value === "number") { sheet.set(cell, value); return; }
  if (kind === "id" && typeof value === "string" && /^\d{1,9}$/.test(value)) { sheet.set(cell, Number(value)); return; }
  sheet.set(cell, String(value));
}

function resizeRows(sheet: XlsxSheet, first: number, capacity: number, needed: number, styleRow: number) {
  const beforeLast = first + Math.min(needed, capacity) - 1;
  if (needed > capacity) sheet.insertRows(first + capacity - 1, needed - capacity, styleRow);
  else if (needed < capacity) sheet.deleteRows(beforeLast, capacity - needed);
  return needed - capacity;
}

function fillLines(sheet: XlsxSheet, model: ExportModel) {
  const items = model.items;
  for (const range of sheet.mergeRanges) {
    const bounds = parseRange(range);
    if (bounds.top >= LINES.first && bounds.bottom < LINES.total) sheet.unmerge(range);
  }
  const rowsPerItem = items.map(item => Math.max(1, item.batches.length));
  const needed = Math.max(1, rowsPerItem.reduce((sum, count) => sum + count, 0));
  resizeRows(sheet, LINES.first, LINES.capacity, needed, LINES.styleRow);
  for (let row = LINES.first; row < LINES.first + needed; row++) for (const column of COLUMNS("A", LINES.lastColumn)) sheet.clear(`${column}${row}`);
  const starts: number[] = [];
  let row = LINES.first;
  items.forEach((item, index) => {
    starts.push(row);
    const count = rowsPerItem[index];
    sheet.set(`A${row}`, index + 1);
    if (item.hsCode) sheet.set(`B${row}`, item.hsCode);
    if (item.productName) sheet.set(`C${row}`, item.productName);
    if (item.supplierSku) sheet.set(`H${row}`, item.supplierSku);
    for (let batch = 0; batch < count; batch++) {
      const target = row + batch;
      const quantity = item.batches[batch]?.quantity ?? null;
      if (quantity !== null) {
        sheet.set(`E${target}`, quantity);
        // The reference book keeps the per-piece net weight inside the row formula (=E17*0.19).
        if (item.netPerPieceKg !== null) sheet.setFormula(`D${target}`, `E${target}*${nf(item.netPerPieceKg)}`);
        if (model.includesPrices && item.unitPrice !== null) { sheet.set(`F${target}`, item.unitPrice); sheet.setFormula(`G${target}`, `F${target}*E${target}`); }
      }
      const expiry = item.batches[batch]?.expiryDate;
      const date = expiry ? formatDateForCell(expiry) : null;
      if (date) sheet.set(`I${target}`, date);
    }
    if (count > 1) for (const column of ["A", "B", "C", "H"]) sheet.merge(`${column}${row}:${column}${row + count - 1}`);
    row += count;
  });
  const last = LINES.first + needed - 1, total = LINES.first + needed;
  for (const column of ["D", "E"]) sheet.setFormula(`${column}${total}`, `SUM(${column}${LINES.first}:${column}${last})`);
  for (const column of ["F", "G"]) {
    // Without prices the totals must stay blank, otherwise CMR and ТТН would print a misleading 0 as the declared value.
    if (model.includesPrices) sheet.setFormula(`${column}${total}`, `SUM(${column}${LINES.first}:${column}${last})`);
    else sheet.set(`${column}${total}`, "", { keepEmptyText: true });
  }
  return starts;
}

function fillPacking(workbook: XlsxWorkbook, sheet: XlsxSheet, model: ExportModel, lineStarts: number[]) {
  const items = model.items;
  const grossTemplate = sheet.formula(PACKING.gFormulaCell), palletTemplate = sheet.formula(PACKING.kFormulaCell);
  const needed = Math.max(1, items.length);
  const delta = resizeRows(sheet, PACKING.first, PACKING.capacity, needed, PACKING.styleRow);
  for (let row = PACKING.first; row < PACKING.first + needed; row++) for (const column of COLUMNS("A", "K")) sheet.clear(`${column}${row}`);
  items.forEach((item, index) => {
    const row = PACKING.first + index;
    const start = lineStarts[index];
    const end = start + Math.max(1, item.batches.length) - 1;
    sheet.set(`A${row}`, index + 1);
    if (item.countryOfOrigin) sheet.set(`B${row}`, item.countryOfOrigin);
    if (item.boxBarcode) sheet.set(`C${row}`, item.boxBarcode);
    sheet.setFormula(`D${row}`, `${LINES_REF}!C${start}`);
    sheet.setFormula(`E${row}`, end > start ? `SUM(${LINES_REF}!E${start}:E${end})` : `${LINES_REF}!E${start}`);
    if (item.netPerPieceKg !== null) {
      sheet.setFormula(`F${row}`, `E${row}*${nf(item.netPerPieceKg)}`);
      // Primary-packaging factor (×1.03) and pallet weight (+25 kg) live in the reference formulas: keep them as they are.
      if (grossTemplate) sheet.setFormula(`G${row}`, translateFormula(grossTemplate, row - PACKING.first, 0));
    }
    if (item.piecesPerBox !== null) sheet.setFormula(`H${row}`, `E${row}/${nf(item.piecesPerBox)}`);
    if (item.pallets !== null) sheet.set(`I${row}`, item.pallets);
    if (item.grossWeightKg !== null) {
      sheet.set(`J${row}`, item.grossWeightKg);
      if (palletTemplate) sheet.setFormula(`K${row}`, translateFormula(palletTemplate, row - PACKING.first, 0));
    }
  });
  const last = PACKING.first + needed - 1, total = PACKING.first + needed;
  for (const column of COLUMNS("E", "K")) sheet.setFormula(`${column}${total}`, `SUM(${column}${PACKING.first}:${column}${last})`);
  if (needed > PACKING.capacity) {
    // More positions than the sample holds: let the table continue on further pages and repeat its header.
    sheet.setFitToHeight(0);
    workbook.setPrintTitleRows(SHEETS.packing, 9, 11);
  }
  return delta;
}

const labelled = (label: string, value: string) => value ? `${label}${value}` : "";

function fillBlocks(workbook: XlsxWorkbook, model: ExportModel, packingDelta: number) {
  const lines = workbook.sheet(SHEETS.lines), driver = workbook.sheet(SHEETS.driver), packing = workbook.sheet(SHEETS.packing);
  const cmr = workbook.sheet(SHEETS.cmr), ttn = workbook.sheet(SHEETS.ttn), instruction = workbook.sheet(SHEETS.instruction);
  const put = (sheet: XlsxSheet, cell: string, value: string) => sheet.set(cell, value, { keepEmptyText: true });
  const footer = (row: number) => row + packingDelta;
  const contract = model.contractNumber ? `№ ${model.contractNumber}${model.contractDate ? ` от ${formatRuDate(model.contractDate)}` : ""}` : "";
  const parties = model.sellerName && model.buyerName ? `${model.sellerName} и ${model.buyerName}` : "";

  put(lines, "C5", contract); put(driver, "C5", contract); put(packing, "K4", contract ? `к Контракту ${contract}` : "");
  put(lines, "C7", parties); put(driver, "C7", parties); put(packing, "K6", parties);

  put(cmr, "A3", model.sellerName); put(cmr, "A4", model.sellerAddress); put(cmr, "A5", model.sellerCountry);
  put(cmr, "A9", model.buyerName); put(cmr, "A10", model.buyerAddress); put(cmr, "A11", "");
  put(cmr, "A12", labelled("ИНН ", model.buyerTaxId)); put(cmr, "B16", model.unloadingCountry);
  put(cmr, "H9", model.carrierName); // box 16 «Перевозчик»: empty in the sample, filled from the shipment on request

  put(ttn, "C11", model.sellerName);
  put(ttn, "B13", [model.sellerName, model.sellerAddress].filter(Boolean).join(" - "));
  put(ttn, "B15", model.buyerName);
  put(ttn, "B36", `${model.senderTitle ? `${model.senderTitle}\n` : ""}ФИО и должность `);

  put(packing, `A${footer(23)}`, model.buyerName);
  put(packing, `A${footer(24)}`, model.unloadingAddress ? `Адрес доставки:\n${model.unloadingAddress}` : "");
  put(packing, `A${footer(25)}`, labelled("ИНН ", model.buyerTaxId));
  put(packing, `A${footer(26)}`, labelled("КПП ", model.buyerKpp));
  put(packing, `F${footer(23)}`, model.sellerName);
  put(packing, `F${footer(24)}`, model.sellerCorrespondenceAddress ? `Адрес для корреспонденции:\n${model.sellerCorrespondenceAddress}` : "");
  put(packing, `F${footer(25)}`, labelled("БИН ", model.sellerTaxId));
  put(packing, `F${footer(26)}`, model.sellerPhone);
  const [bankName = "", ...bankRest] = model.bankDetails.split(/\r?\n/);
  put(packing, `J${footer(23)}`, bankName); put(packing, `J${footer(24)}`, bankRest.join("\n"));
  put(packing, `J${footer(25)}`, ""); put(packing, `J${footer(26)}`, "");

  put(instruction, "C17", model.buyerName); put(instruction, "C18", model.sellerName);
  put(instruction, "C19", model.sellerPhone); put(instruction, "C20", "");
}

export function fillExportWorkbook(template: Uint8Array, model: ExportModel) {
  const workbook = XlsxWorkbook.load(template);
  assertReferenceLayout(workbook);
  const input = workbook.sheet(SHEETS.input);
  for (const field of INPUT_FIELDS) {
    const target = field.targets[0];
    setInput(workbook.sheet(target.sheet), target.cell, field.kind, field.read(model));
  }
  // Notes the template author left under the input block must not reach issued documents.
  for (const cell of ["C29", "C30", "C31"]) input.clear(cell);
  const lineStarts = fillLines(workbook.sheet(SHEETS.lines), model);
  const packingDelta = fillPacking(workbook, workbook.sheet(SHEETS.packing), model, lineStarts);
  fillBlocks(workbook, model, packingDelta);
  return workbook;
}

