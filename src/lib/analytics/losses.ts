// Losses of goods and stock at risk by shelf life (202611280100). The database computes; this file only reads the
// parameters of the page, gives labels and builds the rows of the XLSX export.
export type LossGroup = "product" | "brand" | "warehouse" | "shipment" | "reason" | "month";
export type RiskGroup = "bucket" | "warehouse" | "brand" | "supplier";
export type LossView = "period" | "risk" | "trend" | "unclassified";

export type LossRow = {
  key: string | null; name: string | null; lines: number; incomplete_lines: number; statuses: Record<string, number>;
  pieces: string; cost_kzt: string | null; returns_pieces: string; returns_kzt: string | null; returns_incomplete: number;
  markdown_kzt: string | null; markdown_incomplete: number;
};
export type LossReport = {
  group: LossGroup; from: string; to: string; currency: string; amounts: boolean; rows: LossRow[];
  totals: {
    lines: number; incomplete_lines: number; pieces: string; cost_kzt: string | null; unspecified_lines: number;
    unspecified_cost_kzt: string | null; cost_of_sales_kzt: string | null; share_pct: string | null;
    returns_pieces: string; returns_kzt: string | null; markdown_kzt: string | null; markdown_incomplete: number;
  };
};
export type RiskRow = {
  key: string | null; name: string | null; balances: number; pieces: string; cost_kzt: string | null; incomplete: number;
  no_plan_pieces: string; no_plan_cost_kzt: string | null; min_days_left: number;
};
export type RiskItem = {
  balance_id: string; batch_id: string; sku: string; product: string; brand: string; batch: string; expiry_date: string;
  days_left: number; bucket: string; batch_status: string; warehouse: string | null; location: string | null; uom: string;
  quantity: string; reserved: string; pieces: string | null; plan: string; cost_kzt: string | null; status: string;
};
export type RiskReport = {
  group: RiskGroup; date: string; amounts: boolean; rows: RiskRow[]; items: RiskItem[]; items_total: number;
  buckets: Record<string, { balances: number; pieces: string; cost_kzt: string | null; incomplete: number }> | null;
};
export type TrendMonth = {
  month: string; lines: number; incomplete_lines: number; pieces: string; cost_kzt: string | null;
  cost_of_sales_kzt: string | null; share_pct: string | null; by_reason: Record<string, string>;
};
export type TrendReport = { from: string; to: string; amounts: boolean; reasons: { code: string; name: string }[]; months: TrendMonth[] };
export type UnclassifiedLine = {
  line_id: string; document_id: string; document_number: string; document_date: string; operation_type: string;
  document_reason: string | null; notes: string | null; warehouse: string | null; sku: string; product: string; batch: string;
  quantity: string; uom: string;
};
export type LossLine = {
  line_date: string; source: string; ref_number: string | null; reason: string; warehouse: string | null; sku: string;
  product: string; batch: string; expiry_date: string | null; shipment: string | null; uom: string; quantity: number | string;
  pieces: number | string | null; cost_currency: string | null; cost: number | string | null; rate: number | string | null;
  cost_kzt: number | string | null; status: string;
};

export const lossGroupLabels: Record<LossGroup, string> = {
  reason: "По причинам", product: "По товарам", brand: "По брендам", warehouse: "По складам", shipment: "По поставкам", month: "По месяцам",
};
export const riskGroupLabels: Record<RiskGroup, string> = {
  bucket: "По сроку", warehouse: "По складам", brand: "По брендам", supplier: "По поставщикам",
};
export const lossViewLabels: Record<LossView, string> = {
  period: "Потери за период", risk: "Товар под риском", trend: "Динамика", unclassified: "Без причины",
};
export const lossStatusLabels: Record<string, string> = {
  complete: "полные данные", no_cost: "нет себестоимости", no_packaging: "нет упаковки", no_rate: "нет курса",
  no_price: "нет цены продажи", no_vat_rate: "нет ставки НДС", no_list_price: "нет цены прайса в строке заказа",
};
export const planLabels: Record<string, string> = {
  program: "в распродаже низкого срока", reserved: "в резерве под заказ", partly_reserved: "частично в резерве", none: "нет плана продажи",
};
export const sourceLabels: Record<string, string> = {
  document: "Складской документ", return: "Списание возврата", movement: "Прямое списание (до документов)",
};
export const unitLabels: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOSS_GROUPS = Object.keys(lossGroupLabels) as LossGroup[];
const RISK_GROUPS = Object.keys(riskGroupLabels) as RiskGroup[];
const VIEWS = Object.keys(lossViewLabels) as LossView[];

/** View, groups and period from the query string; default: losses of the current month in Kazakhstan by reason. */
export function parseLossParams(params: { view?: string; group?: string; risk?: string; from?: string; to?: string }, today: string) {
  const view: LossView = VIEWS.includes(params.view as LossView) ? params.view as LossView : "period";
  const group: LossGroup = LOSS_GROUPS.includes(params.group as LossGroup) ? params.group as LossGroup : "reason";
  const risk: RiskGroup = RISK_GROUPS.includes(params.risk as RiskGroup) ? params.risk as RiskGroup : "bucket";
  const from = params.from && DAY.test(params.from) ? params.from : `${today.slice(0, 7)}-01`;
  const to = params.to && DAY.test(params.to) ? params.to : today;
  return from <= to ? { view, group, risk, from, to } : { view, group, risk, from: to, to: from };
}

export function money(value: string | number | null | undefined) {
  if (value == null || value === "") return "—";
  return Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function pieces(value: string | number | null | undefined) {
  if (value == null || value === "") return "—";
  return Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}

export function percent(value: string | number | null | undefined) {
  return value == null || value === "" ? "—" : `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} %`;
}

/** "2026-11" -> "ноябрь 2026". */
export function monthLabel(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) return month;
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T00:00:00Z`))
    .replace(/\s*г\.$/, "");
}

/** What keeps a row from complete data, as text; empty when everything is complete. */
export function incompleteText(statuses: Record<string, number>) {
  return Object.entries(statuses).filter(([status]) => status !== "complete")
    .map(([status, count]) => `${lossStatusLabels[status] ?? status}: ${count}`).join(", ");
}

/** Name of a group row: the report gives it; a month key is shown as a month. */
export function rowName(group: LossGroup, row: Pick<LossRow, "key" | "name">) {
  if (group === "month" && row.key) return monthLabel(row.key);
  return row.name ?? "—";
}

const number = (value: unknown) => value == null || value === "" ? null : Number(value);

/** Rows of the export: one line per lost line; text stays text (inlineStr), amounts are empty without the right. */
export function lossLineRows(lines: LossLine[]) {
  const header = ["Дата", "Источник", "Документ", "Причина", "Склад", "Артикул", "Товар", "Партия", "Срок годности", "Поставка",
    "Единица", "Количество", "Штук", "Валюта себестоимости", "Себестоимость", "Курс", "Себестоимость, KZT", "Отметка"];
  return [header, ...lines.map(line => [
    line.line_date, sourceLabels[line.source] ?? line.source, line.ref_number ?? "", line.reason, line.warehouse ?? "", line.sku,
    line.product, line.batch, line.expiry_date ?? "", line.shipment ?? "", unitLabels[line.uom] ?? line.uom, number(line.quantity),
    number(line.pieces), line.cost_currency ?? "", number(line.cost), number(line.rate), number(line.cost_kzt),
    lossStatusLabels[line.status] ?? line.status,
  ])];
}

/** Rows of stock at risk for the export. */
export function riskItemRows(items: RiskItem[]) {
  const header = ["Артикул", "Товар", "Бренд", "Партия", "Срок годности", "Дней до конца срока", "Склад", "Место", "Единица",
    "Количество", "В резерве", "Штук", "План", "Себестоимость, KZT", "Отметка"];
  return [header, ...items.map(item => [
    item.sku, item.product, item.brand, item.batch, item.expiry_date, item.days_left, item.warehouse ?? "", item.location ?? "",
    unitLabels[item.uom] ?? item.uom, number(item.quantity), number(item.reserved), number(item.pieces), planLabels[item.plan] ?? item.plan,
    number(item.cost_kzt), lossStatusLabels[item.status] ?? item.status,
  ])];
}
