import { parsePurchasePriceReport, type PurchasePriceReport } from "../calculator-import/purchase-prices.ts";
// The report returned by public.import_reference_data() and its Russian labels.

export const IMPORT_STATUSES = ["create", "update", "unchanged", "conflict", "error"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
export const REPORT_ENTITIES = ["counterparty", "product", "identifier", "packaging"] as const;
export type ReportEntity = (typeof REPORT_ENTITIES)[number];

export type ReportItem = {
  entity: ReportEntity;
  row: number;
  key: string;
  status: ImportStatus;
  changes: string[];
  message: string | null;
};

export type ImportReport = {
  summary: Record<ImportStatus, number>;
  items: ReportItem[];
  purchasePrices?: PurchasePriceReport;
  dryRun: boolean;
  applied: boolean;
};

export const statusLabel: Record<ImportStatus, string> = {
  create: "Создание",
  update: "Обновление",
  unchanged: "Без изменений",
  conflict: "Конфликт",
  error: "Ошибка",
};

export const entityLabel: Record<ReportEntity, string> = {
  counterparty: "Контрагент",
  product: "Товар",
  identifier: "Идентификатор",
  packaging: "Упаковка",
};

export const fieldLabel: Record<string, string> = {
  legal_name: "юр. название", short_name: "краткое название", tax_id: "БИН/ИНН", registration_number: "рег. номер",
  website: "сайт", preferred_locale: "язык", roles: "роли", name: "название", manufacturer: "производитель", brand: "бренд",
  country_of_origin: "страна происхождения", hs_code: "ТН ВЭД", shelf_life_days: "срок годности", composition: "состав",
  nutrition_facts: "КБЖУ", temperature_regime: "температурный режим", temperature_range: "диапазон температур",
  base_uom: "базовая единица", requires_sticker: "стикеровка", requires_marking: "маркировка", status: "статус",
  packaging_uom: "уровень упаковки", is_primary: "основной", units_per_parent: "вложение", gross_weight_kg: "брутто",
  net_weight_kg: "нетто", volume_m3: "объём", length_cm: "длина", width_cm: "ширина", height_cm: "высота",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

// Checks the shape of the RPC result (or of the report in an error's details) so the page
// never renders unexpected data.
export function parseReport(value: unknown): ImportReport | null {
  if (!isRecord(value) || !isRecord(value.summary) || !Array.isArray(value.items)) return null;
  const summary = Object.fromEntries(
    IMPORT_STATUSES.map((status) => [status, Number((value.summary as Record<string, unknown>)[status]) || 0]),
  ) as Record<ImportStatus, number>;
  const items: ReportItem[] = [];
  for (const item of value.items) {
    if (!isRecord(item)) continue;
    const status = item.status as ImportStatus;
    const entity = item.entity as ReportEntity;
    if (!IMPORT_STATUSES.includes(status) || !REPORT_ENTITIES.includes(entity)) continue;
    items.push({
      entity,
      row: Number(item.row) || 0,
      key: String(item.key ?? ""),
      status,
      changes: Array.isArray(item.changes) ? item.changes.map(String) : [],
      message: typeof item.message === "string" ? item.message : null,
    });
  }
  const purchasePrices = parsePurchasePriceReport(value.purchase_prices);
  return { summary, items, ...(purchasePrices ? {purchasePrices} : {}), dryRun: value.dry_run !== false, applied: value.applied === true };
}

export function hasProblems(report: ImportReport): boolean {
  return report.summary.conflict + report.summary.error > 0;
}

export function hasChanges(report: ImportReport): boolean {
  return report.summary.create + report.summary.update > 0;
}

const ORDER: Record<ImportStatus, number> = { error: 0, conflict: 1, create: 2, update: 3, unchanged: 4 };

// Problems first, then changes, then untouched rows; stable within a status.
export function sortReportItems(items: ReportItem[]): ReportItem[] {
  return items.map((item, index) => ({ item, index }))
    .sort((a, b) => ORDER[a.item.status] - ORDER[b.item.status] || a.index - b.index)
    .map(({ item }) => item);
}
