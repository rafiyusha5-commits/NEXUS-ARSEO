// Executive dashboard (202611280400): tile types, the month parameter and wording. Every figure comes from the tile
// function of the database, which reads the source reports; nothing is calculated here.

export const DASHBOARD_TILES = ["revenue", "receivables", "payables", "cash", "shelf_life", "shipments", "decisions"] as const;
export type DashboardTileKey = (typeof DASHBOARD_TILES)[number];

type Base = { tile: DashboardTileKey; status: "ok"; month: string; previous_month: string; incomplete: boolean; link: string };
type Amount = { currency: string };
export type RevenueTile = Base & { tile: "revenue"; revenue_net: string; profit: string; complete_revenue: string; margin_pct: string | null;
  complete_share_pct: string | null; lines: number; incomplete_lines: number;
  previous: { revenue_net: string; profit: string; margin_pct: string | null } };
export type ReceivablesTile = Base & { tile: "receivables"; currencies: Array<Amount & { overdue: string; kzt: string | null }>;
  overdue_kzt: string | null; customers: number;
  top: Array<{ customer_id: string; customer: string; kzt: string | null; days: number | null; amounts: Array<Amount & { overdue: string }> }> };
export type PayablesTile = Base & { tile: "payables"; currencies: Array<Amount & { overdue: string; due_14: string; rest: string;
  overdue_kzt: string | null; due_14_kzt: string | null }>; overdue_kzt: string | null; due_14_kzt: string | null; goods: boolean };
export type CashTile = Base & { tile: "cash"; currencies: Array<Amount & { first_gap: string | null; first_gap_with_plan: string | null;
  opening: string | null; balance_known: boolean }>; nearest: { currency: string; date: string; week: string } | null;
  receivables: boolean; goods: boolean };
export type ShelfLifeTile = Base & { tile: "shelf_life";
  risk: { expired_kzt: string | null; critical_kzt: string | null; warning_kzt: string | null; expired_pieces: string; critical_pieces: string;
    warning_pieces: string; urgent_kzt: string | null; urgent_pieces: string; incomplete: number };
  losses: { cost_kzt: string | null; pieces: string; lines: number; incomplete_lines: number };
  previous: { cost_kzt: string | null; pieces: string }; amounts: boolean };
export type ShipmentsTile = Base & { tile: "shipments"; active: number; late: number; in_transit: number; vehicles_on_road: number;
  stages_late: number; stages_blocked: number };
export type DecisionsTile = Base & { tile: "decisions"; approvals: number; price_reviews: number; blocked_orders: number;
  tasks_overdue: number | null; unpriced_orders: number | null; total: number };
export type ErrorTile = { tile: DashboardTileKey; status: "error"; month?: string };
export type DashboardTile = RevenueTile | ReceivablesTile | PayablesTile | CashTile | ShelfLifeTile | ShipmentsTile | DecisionsTile | ErrorTile;

export const tileTitle: Record<DashboardTileKey, string> = {
  revenue: "Выручка и маржа", receivables: "Просроченные долги клиентов", payables: "К оплате поставщикам", cash: "Прогноз денег",
  shelf_life: "Сроки годности", shipments: "Поставки", decisions: "Требует решения",
};
/** Where a tile that failed to load still leads: the source report. */
export const tileSource: Record<DashboardTileKey, string> = {
  revenue: "/analytics/profitability", receivables: "/finance/receivables", payables: "/finance/payables", cash: "/finance/cash",
  shelf_life: "/analytics/losses", shipments: "/analytics", decisions: "/notifications",
};

/** The month of the dashboard: ?month=YYYY-MM, never in the future; the first day as YYYY-MM-DD. */
export function dashboardMonth(raw: string | string[] | undefined, today: string) {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const current = `${today.slice(0, 7)}-01`;
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return current;
  const month = `${value}-01`;
  return month > current ? current : month;
}
export function shiftMonth(month: string, delta: number) {
  const date = new Date(`${month}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}
export function monthLabel(month: string) {
  return new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month.slice(0, 7)}-01T00:00:00Z`));
}

export function kzt(value: string | null | undefined) {
  if (value == null) return "—";
  return `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 0 })} ₸`;
}
export function amount(value: string | number | null | undefined, currency = "") {
  if (value == null) return "—";
  return `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;
}
export function percent(value: string | null | undefined) {
  return value == null ? "—" : `${Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;
}
export function day(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)) : "—";
}

/** Change against the previous month in words: "+12% к прошлому месяцу", "на уровне прошлого месяца", or nothing without a base. */
export function change(current: string | null | undefined, previous: string | null | undefined) {
  if (current == null || previous == null) return null;
  const now = Number(current), before = Number(previous);
  if (before === 0) return now === 0 ? "как в прошлом месяце" : null;
  const delta = (now - before) / Math.abs(before) * 100;
  if (Math.abs(delta) < 0.5) return "на уровне прошлого месяца";
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString("ru-RU", { maximumFractionDigits: 0 })}% к прошлому месяцу`;
}

/** What needs attention, for a short line under the page title and the assistant. */
export function attention(tiles: DashboardTile[]): string[] {
  const out: string[] = [];
  for (const tile of tiles) {
    if (tile.status !== "ok") { out.push(`${tileTitle[tile.tile]}: нет данных`); continue; }
    if (tile.tile === "cash" && tile.nearest) out.push(`Кассовый разрыв в ${tile.nearest.currency} с ${day(tile.nearest.date)}`);
    if (tile.tile === "receivables" && tile.customers > 0) out.push(`Просрочка клиентов: ${tile.customers}`);
    if (tile.tile === "payables" && tile.currencies.some(item => Number(item.overdue) > 0)) out.push("Есть просроченные оплаты поставщикам");
    if (tile.tile === "shipments" && tile.late > 0) out.push(`Поставок с опозданием: ${tile.late}`);
    if (tile.tile === "decisions" && tile.total > 0) out.push(`Ждут решения: ${tile.total}`);
  }
  return out;
}
