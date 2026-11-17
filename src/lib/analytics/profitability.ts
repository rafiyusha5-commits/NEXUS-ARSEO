// Profitability report (202611170500): the database computes; this file only reads parameters and formats.
export type ProfitGroup = "shipment" | "product" | "customer";
export type ProfitRow = {
  key: string | null; name: string; sales_net: string; sales_gross: string; returns_net: string; returns_cost: string;
  revenue_net: string; revenue_gross: string; complete_revenue: string; cost: string; profit: string;
  margin_pct: string | number | null; complete_share_pct: string | number | null;
  sold_pieces: string; returned_pieces: string; unsold_pieces: string | null; statuses: Record<string, number>; old_rule: boolean;
};
export type ProfitReport = {
  group: ProfitGroup; from: string; to: string; currency: string; rows: ProfitRow[];
  totals: { sales_net: string; returns_net: string; revenue_net: string; revenue_gross: string; complete_revenue: string; cost: string; profit: string; lines: number; incomplete_lines: number };
};
export type ProfitLine = Record<string, string | number | boolean | null>;

export const groupLabels: Record<ProfitGroup, string> = { shipment: "По поставкам", product: "По товарам", customer: "По клиентам" };
export const statusLabels: Record<string, string> = {
  approved: "утверждено", preliminary: "предварительно", no_price: "нет цены продажи", no_cost: "нет себестоимости",
  no_rate: "нет курса", no_vat_rate: "нет ставки НДС", no_packaging: "нет упаковки",
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Group and period from the query string; default: the current month in Kazakhstan. */
export function parseProfitParams(params: { group?: string; from?: string; to?: string }, today: string) {
  const group: ProfitGroup = params.group === "product" || params.group === "customer" ? params.group : "shipment";
  const from = params.from && DAY.test(params.from) ? params.from : `${today.slice(0, 7)}-01`;
  const to = params.to && DAY.test(params.to) ? params.to : today;
  return from <= to ? { group, from, to } : { group, from: to, to: from };
}

export function money(value: string | number | null | undefined) {
  if (value == null || value === "") return "—";
  return Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function percent(value: string | number | null | undefined) {
  return value == null ? "—" : `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} %`;
}

/** Statuses of a row other than "утверждено", as text: what keeps it from being complete. */
export function incompleteText(statuses: Record<string, number>) {
  return Object.entries(statuses).filter(([status]) => status !== "approved")
    .map(([status, count]) => `${statusLabels[status] ?? status}: ${count}`).join(", ");
}

/** Rows of the export: one line per shipped or returned batch, text stays text (inlineStr). */
export function profitLineRows(lines: ProfitLine[]) {
  const header = ["Вид", "Дата", "Заказ", "Клиент", "Товар", "Партия", "Поставка", "Штук", "Валюта продажи", "Выручка с НДС",
    "НДС в цене", "Ставка НДС", "Выручка без НДС", "Курс выручки", "Дата курса", "Валюта себестоимости", "Себестоимость",
    "Себестоимость", "Курс себестоимости", "Выручка без НДС, KZT", "Выручка с НДС, KZT", "Себестоимость, KZT", "Валовая прибыль, KZT",
    "Отметка", "По прежнему правилу"];
  const number = (value: unknown) => value == null || value === "" ? null : Number(value);
  return [header, ...lines.map(line => [
    line.kind === "return" ? "Возврат" : "Продажа", line.date as string, line.sale_number as string, line.customer as string,
    line.product as string, line.batch as string, (line.shipment as string) ?? "", number(line.pieces), line.sale_currency as string,
    number(line.revenue_gross), line.vat_included ? "да" : "нет", number(line.vat_rate), number(line.revenue_net), number(line.revenue_rate),
    (line.revenue_rate_date as string) ?? "", (line.cost_currency as string) ?? "", number(line.cost),
    line.cost_status === "approved" ? "утверждена" : line.cost_status === "preliminary" ? "предварительная" : "нет",
    number(line.cost_rate), number(line.revenue_net_kzt), number(line.revenue_gross_kzt), number(line.cost_kzt), number(line.profit_kzt),
    statusLabels[line.status as string] ?? (line.status as string), line.old_rule ? "да" : "нет",
  ])];
}
