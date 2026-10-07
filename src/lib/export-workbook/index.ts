// Entry point of the export document package: one filled workbook plus CMR, ТТН and packing list
// taken from the sheets of that same workbook. No separate drawing of the forms exists anywhere.

import { fillExportWorkbook } from "./fill.ts";
import { SHEETS } from "./field-map.ts";
import { buildExportModel, type ExportModel, type ExportOutput } from "./model.ts";
import { preflightExport, type PreflightResult } from "./preflight.ts";
import { XlsxWorkbook, XLSX_CONTENT_TYPE } from "./xlsx-package.ts";

export { XLSX_CONTENT_TYPE };
export { buildExportModel, preflightExport };
export type { ExportModel, ExportOutput, PreflightResult };
export { TemplateLayoutError } from "./fill.ts";

/** Sheets of the reference workbook that are the printable forms. */
export const OUTPUT_SHEETS: Record<Exclude<ExportOutput, "workbook">, string> = {
  cmr: SHEETS.cmr,
  ttn: SHEETS.ttn,
  packing_list: SHEETS.packing,
};

export const OUTPUT_LABELS: Record<ExportOutput, string> = {
  workbook: "Заполненная книга отгрузки",
  cmr: "CMR",
  ttn: "ТТН",
  packing_list: "Упаковочный лист",
};

export class PreflightError extends Error {
  readonly result: PreflightResult;
  constructor(result: PreflightResult) {
    super(`Не заполнены обязательные данные: ${result.issues.filter(issue => issue.severity === "required").map(issue => issue.label).join("; ")}`);
    this.result = result;
  }
}

/** Keeps one sheet as a standalone book: formulas become values, every other sheet is dropped, print setup and drawings stay. */
export function extractSheetWorkbook(filledBook: Uint8Array, sheetName: string) {
  const workbook = XlsxWorkbook.load(filledBook);
  workbook.freezeFormulas(sheetName);
  for (const name of workbook.sheetNames()) if (name !== sheetName) workbook.removeSheet(name);
  return workbook.toBytes({ recalculate: false });
}

export type ExportDocument = { output: ExportOutput; label: string; bytes: Uint8Array };

export function buildExportDocuments(template: Uint8Array, data: Record<string, unknown>, outputs: ExportOutput[], options: { includePrices?: boolean } = {}): ExportDocument[] {
  const model = buildExportModel(data);
  const check = preflightExport(model, outputs, options);
  if (!check.ready) throw new PreflightError(check);
  const book = fillExportWorkbook(template, model).toBytes();
  return outputs.map(output => ({
    output,
    label: OUTPUT_LABELS[output],
    bytes: output === "workbook" ? book : extractSheetWorkbook(book, OUTPUT_SHEETS[output]),
  }));
}
