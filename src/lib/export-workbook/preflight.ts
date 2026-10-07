// Pre-flight check: which cells of the selected documents would stay empty, and which of those
// block issuing. The list is meant to be read by staff, so every row says what is missing, where it
// appears in the document and where the value normally comes from.

import { BLOCK_FIELDS, INPUT_FIELDS, SHEETS, type FieldSpec } from "./field-map.ts";
import type { ExportItem, ExportModel, ExportOutput } from "./model.ts";

export type PreflightIssue = {
  key: string;
  label: string;
  severity: "required" | "recommended";
  where: string;
  source: string;
  outputs: ExportOutput[];
};

export type PreflightResult = {
  ready: boolean;
  requiredMissing: number;
  recommendedMissing: number;
  issues: PreflightIssue[];
};

const ALL: ExportOutput[] = ["workbook", "cmr", "ttn", "packing_list"];

const isRelevant = (spec: { outputs: ExportOutput[] }, selected: ExportOutput[]) =>
  selected.includes("workbook") || spec.outputs.some(output => selected.includes(output));

const documentCells = (spec: FieldSpec) => spec.targets.map(target => `${target.sheet}!${target.cell}`).join(", ");

function itemIssues(item: ExportItem, index: number, selected: ExportOutput[], includePrices: boolean) {
  const issues: PreflightIssue[] = [];
  const title = `Позиция ${index + 1}${item.productName ? ` «${item.productName}»` : ""}`;
  const add = (suffix: string, key: string, severity: PreflightIssue["severity"], where: string, source: string, outputs: ExportOutput[]) => {
    if (isRelevant({ outputs }, selected)) issues.push({ key: `items.${index}.${key}`, label: `${title}: ${suffix}`, severity, where, source, outputs });
  };
  if (!item.productName) add("наименование", "name", "required", `${SHEETS.lines}, столбец C`, "Карточка товара", ["packing_list", "ttn"]);
  if (!item.hsCode) add("код ТН ВЭД", "hs", "required", `${SHEETS.lines}, столбец B; CMR!J28`, "Карточка товара", ["cmr"]);
  if (!item.batches.some(batch => batch.quantity !== null)) add("количество, шт", "pieces", "required", `${SHEETS.lines}, столбец E`, "Строка поставки и упаковка товара", ["packing_list"]);
  if (item.netPerPieceKg === null) add("вес нетто (на единицу или на строку)", "net", "required", `${SHEETS.lines}, столбец D; ${SHEETS.packing}, столбцы F–G`, "Упаковка товара", ["packing_list"]);
  if (item.piecesPerBox === null) add("штук в транспортном коробе", "box", "required", `${SHEETS.packing}, столбец H`, "Упаковка товара", ["packing_list"]);
  if (item.pallets === null) add("количество поддонов", "pallets", "required", `${SHEETS.packing}, столбец I`, "Упаковка товара", ["packing_list", "cmr", "ttn"]);
  if (item.grossWeightKg === null) add("вес брутто", "gross", "required", `${SHEETS.packing}, столбцы J–K; CMR!L28; ТТН!X27`, "Упаковка товара", ["packing_list", "cmr", "ttn"]);
  if (!item.countryOfOrigin) add("страна происхождения", "country", "recommended", `${SHEETS.packing}, столбец B`, "Карточка товара", ["packing_list"]);
  if (!item.boxBarcode) add("штрих-код короба", "barcode", "recommended", `${SHEETS.packing}, столбец C`, "Идентификаторы товара", ["packing_list"]);
  if (!item.supplierSku) add("артикул производителя", "sku", "recommended", `${SHEETS.lines}, столбец H`, "Идентификаторы товара", ["workbook"]);
  item.batches.forEach((batch, batchIndex) => {
    if (!batch.expiryDate) add(`срок годности${item.batches.length > 1 ? ` партии ${batchIndex + 1}` : ""}`, `expiry.${batchIndex}`, "recommended", `${SHEETS.lines}, столбец I`, "Инвойс / партия поставщика", ["workbook"]);
  });
  if (includePrices && item.unitPrice === null) add("цена", "price", "recommended", `${SHEETS.lines}, столбцы F–G; CMR!C37; ТТН!N27`, "Инвойс", ["cmr", "ttn"]);
  return issues;
}

export function preflightExport(model: ExportModel, selected: ExportOutput[] = ALL, options: { includePrices?: boolean } = {}): PreflightResult {
  const includePrices = options.includePrices ?? model.includesPrices;
  const issues: PreflightIssue[] = [];
  for (const spec of [...INPUT_FIELDS, ...BLOCK_FIELDS]) {
    if (!isRelevant(spec, selected) || spec.read(model) !== null) continue;
    issues.push({ key: spec.key, label: spec.label, severity: spec.required ? "required" : "recommended", where: documentCells(spec), source: spec.source, outputs: spec.outputs.length ? spec.outputs : ["workbook"] });
  }
  if (!model.items.length) {
    issues.push({ key: "items", label: "Товарные позиции", severity: "required", where: `${SHEETS.lines}, ${SHEETS.packing}`, source: "Вкладка «Товары» поставки", outputs: ["packing_list", "cmr", "ttn"] });
  }
  model.items.forEach((item, index) => issues.push(...itemIssues(item, index, selected, includePrices)));
  if (!includePrices && selected.some(output => ["workbook", "cmr", "ttn"].includes(output))) {
    issues.push({ key: "prices", label: "Объявленная стоимость и сумма (цены не включены)", severity: "recommended", where: "CMR!C37, ТТН!N27, для Диляры, столбцы F–G", source: "Инвойс; требуется право на цены", outputs: ["cmr", "ttn"] });
  }
  model.invoiceNotes.forEach((note, index) => issues.push({ key: `invoice.${index}`, label: `Сверка с инвойсом: ${note}`, severity: "recommended", where: "для Диляры, упаков.лист (таблицы товаров)", source: "Подтверждённый инвойс", outputs: ["workbook"] }));
  const requiredMissing = issues.filter(issue => issue.severity === "required").length;
  return { ready: requiredMissing === 0, requiredMissing, recommendedMissing: issues.length - requiredMissing, issues };
}
