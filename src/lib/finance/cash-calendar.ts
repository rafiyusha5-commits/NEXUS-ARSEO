// Payment calendar (202611280200): types, parameters, wording and XLSX rows. Amounts come from the database as decimal
// strings, per currency; they are never added across currencies here. Tenge is an estimate column only.
import type { XlsxCell } from "../xlsx.ts";
import { expenseTypeLabel, money } from "./payables.ts";

export type CashStep = "week" | "day";
export type CashView = "calendar" | "items" | "plan-fact";
export type CashBucket = "period" | "overdue" | "no_date" | "later";

export type CashPeriod = {
  start: string; end: string; in_receivables: string; in_orders: string; out_payables: string; out_planned: string;
  closing: string | null; closing_with_plan: string | null; closing_kzt: string | null; gap: boolean; gap_with_plan: boolean;
};
export type CashOpening = {
  amount: string | null; as_of: string | null; accounts: number; accounts_without_balance: number;
  list: Array<{ id: string; name: string; bank: string | null; as_of: string | null; amount: string | null }>;
};
export type CashCurrency = {
  currency_id: string; currency: string; opening: CashOpening; rate_kzt: string | null;
  overdue_in: string; overdue_out: string; no_date_out: string; later_in: string; later_orders: string; later_out: string; later_planned: string;
  orders_with_unpriced: number; advances: string; overpayments: string; first_gap: string | null; first_gap_with_plan: string | null;
  periods: CashPeriod[];
};
export type CashCalendar = {
  today: string; step: CashStep; from: string; to: string; receivables: boolean; goods: boolean; can_manage: boolean;
  gap_alert_days: number; currencies: CashCurrency[];
};
export type CashItem = {
  kind: "receivable" | "order" | "payable" | "planned"; direction: "in" | "out"; ref_type: string; ref_id: string; ref_label: string | null;
  counterparty_id: string | null; date: string | null; due_date: string | null; amount: string; note: string | null;
};
export type CashCell = { total: number; limit: number; amount_in: string; amount_out: string; items: CashItem[] };
export type CashPlanFactWeek = { start: string; end: string; plan_in: string; fact_in: string; plan_out: string; fact_out: string };
export type CashPlanFact = { from: string; to: string; receivables: boolean; goods: boolean; currencies: Array<{ currency: string; weeks: CashPlanFactWeek[] }> };
export type CashAccount = {
  id: string; name: string; bank: string | null; currency: string; currency_id: string; is_active: boolean;
  history: Array<{ as_of: string; amount: string; note: string | null; author: string | null; created_at: string }>;
};

export type CashParams = { step: CashStep; periods: number; view: CashView; currency: string | null; bucket: CashBucket | null; from: string | null; to: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** Weeks: 13 ahead; days: the next two weeks (owner decision Б2). Anything else falls back to the defaults. */
export function parseCashParams(raw: Record<string, string | string[] | undefined>): CashParams {
  const step: CashStep = one(raw.step) === "day" ? "day" : "week";
  const view: CashView = one(raw.view) === "items" ? "items" : one(raw.view) === "plan-fact" ? "plan-fact" : "calendar";
  const currency = UUID.test(one(raw.currency)) ? one(raw.currency) : null;
  const bucketRaw = one(raw.bucket);
  const bucket = (["period", "overdue", "no_date", "later"] as const).find(value => value === bucketRaw) ?? null;
  const from = DATE.test(one(raw.from)) ? one(raw.from) : null;
  const to = DATE.test(one(raw.to)) ? one(raw.to) : null;
  return { step, periods: step === "day" ? 14 : 13, view, currency, bucket, from, to };
}

export function cashDay(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`)) : "—";
}

export function periodLabel(period: Pick<CashPeriod, "start" | "end">, step: CashStep) {
  if (step === "day") {
    const date = new Date(`${period.start}T00:00:00`);
    return `${new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit" }).format(date)}, ${new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date)}`;
  }
  return `${cashDay(period.start)} — ${cashDay(period.end)}`;
}

/** Monday of the week of a date (ISO), as YYYY-MM-DD. */
export function weekStart(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/** The gap in words, never only by colour. */
export function gapText(currency: CashCurrency): string {
  if (currency.opening.amount == null) {
    return currency.opening.accounts
      ? `Остаток введён не по всем счетам ${currency.currency}: разрыв не определяется`
      : `Остаток на счетах в ${currency.currency} не введён: разрыв не определяется`;
  }
  if (currency.first_gap) return `Кассовый разрыв в ${currency.currency} с ${cashDay(currency.first_gap)} (неделя с ${cashDay(weekStart(currency.first_gap))})`;
  if (currency.first_gap_with_plan) return `Разрыва по подтверждённым суммам нет; с учётом плана — с ${cashDay(currency.first_gap_with_plan)}`;
  return `Кассового разрыва в ${currency.currency} в горизонте нет`;
}

/** A balance older than three days is stale: the calendar starts from it as if nothing had been paid since. */
export function staleBalanceText(opening: CashOpening, today: string): string | null {
  if (!opening.as_of) return null;
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${opening.as_of}T00:00:00Z`)) / 86_400_000);
  return days > 3 ? `Остаток на ${cashDay(opening.as_of)} — ${days} дн. назад; обновите его, иначе оплаты за эти дни не учтены` : null;
}

export const cashKindLabel: Record<CashItem["kind"], string> = {
  receivable: "Долг клиента", order: "Заказ, ещё не отгружен", payable: "Расход к оплате", planned: "Плановый расход",
};

export function cashItemHref(item: CashItem): string | null {
  if (item.kind === "receivable" && item.counterparty_id && UUID.test(item.counterparty_id)) return `/finance/receivables/${item.counterparty_id}`;
  if (item.kind === "order" && UUID.test(item.ref_id)) return `/sales/${item.ref_id}`;
  if (item.kind === "payable" || item.kind === "planned") return `/finance/payables/${item.counterparty_id && UUID.test(item.counterparty_id) ? item.counterparty_id : "none"}`;
  return null;
}

export function cashItemNote(item: CashItem): string {
  if (item.kind === "order") return item.note?.startsWith("unpriced_lines:") ? `строк без цены: ${item.note.slice("unpriced_lines:".length)} — сумма без них` : "дата отгрузки + отсрочка клиента";
  if (item.kind === "payable" || item.kind === "planned") return item.note ? expenseTypeLabel[item.note] ?? item.note : "";
  return "";
}

/** Link to the items of one cell. */
export function cellHref(params: { step: CashStep; currency: string; bucket: CashBucket; from?: string; to?: string }) {
  const query = new URLSearchParams({ view: "items", step: params.step, currency: params.currency, bucket: params.bucket });
  if (params.from) query.set("from", params.from);
  if (params.to) query.set("to", params.to);
  return `/finance/cash?${query.toString()}`;
}

export function dayAfter(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

const num = (value: string | null | undefined): XlsxCell => value == null ? null : Number(value);

/** The calendar as one sheet: a block per currency, periods as rows, then what lies outside the periods. */
export function calendarRows(calendar: CashCalendar): XlsxCell[][] {
  const rows: XlsxCell[][] = [[`Платёжный календарь на ${cashDay(calendar.today)}`, calendar.step === "week" ? "по неделям" : "по дням"]];
  if (!calendar.receivables) rows.push(["Без права на дебиторку: поступления от клиентов и по заказам не показаны"]);
  if (!calendar.goods) rows.push(["Без права на закупочные цены: оплаты за товар не показаны, остаток может быть завышен"]);
  for (const currency of calendar.currencies) {
    rows.push([]);
    rows.push([`Валюта ${currency.currency}`, "Остаток на начало", num(currency.opening.amount), currency.opening.as_of ? `на ${cashDay(currency.opening.as_of)}` : "не введён"]);
    rows.push([gapText(currency)]);
    rows.push(["Период", "Поступления: долги клиентов", "Ожидается по заказам (план)", "Выплаты: расходы", "Плановые расходы",
      "Остаток", "Остаток с планом", "Остаток, KZT (оценка)", "Разрыв"]);
    for (const period of currency.periods) {
      rows.push([periodLabel(period, calendar.step), num(period.in_receivables), num(period.in_orders), num(period.out_payables), num(period.out_planned),
        num(period.closing), num(period.closing_with_plan), num(period.closing_kzt), period.gap ? "кассовый разрыв" : period.gap_with_plan ? "разрыв с учётом плана" : ""]);
    }
    rows.push([`После ${cashDay(calendar.to)}`, num(currency.later_in), num(currency.later_orders), num(currency.later_out), num(currency.later_planned)]);
    rows.push(["Просрочено (не разнесено по неделям)", num(currency.overdue_in), null, num(currency.overdue_out)]);
    rows.push(["Срок оплаты не задан", null, null, num(currency.no_date_out)]);
    rows.push(["Справочно: авансы без зачёта", null, null, num(currency.advances)]);
    rows.push(["Справочно: переплаты к возврату", num(currency.overpayments)]);
    if (currency.rate_kzt == null && currency.currency !== "KZT") rows.push([`Нет официального курса ${currency.currency} за 7 дней: оценки в тенге нет`]);
  }
  return rows;
}

export function planFactRows(planFact: CashPlanFact): XlsxCell[][] {
  const rows: XlsxCell[][] = [[`План-факт с ${cashDay(planFact.from)} по ${cashDay(planFact.to)}`]];
  for (const currency of planFact.currencies) {
    rows.push([]);
    rows.push([`Валюта ${currency.currency}`, "Ожидалось поступлений", "Поступило", "Ожидалось выплат", "Выплачено"]);
    for (const week of currency.weeks) rows.push([periodLabel(week, "week"), num(week.plan_in), num(week.fact_in), num(week.plan_out), num(week.fact_out)]);
  }
  return rows;
}

export function itemRows(currency: string, title: string, cell: CashCell): XlsxCell[][] {
  const rows: XlsxCell[][] = [[`${currency}: ${title}`, `строк: ${cell.total}`, cell.total > cell.items.length ? `показаны первые ${cell.items.length}` : ""],
    ["Вид", "Контрагент или документ", "Дата в календаре", "Срок", "Поступление", "Выплата", "Примечание"]];
  for (const item of cell.items) {
    rows.push([cashKindLabel[item.kind], item.ref_label ?? "—", item.date ? cashDay(item.date) : "срок не задан", item.due_date ? cashDay(item.due_date) : "—",
      item.direction === "in" ? Number(item.amount) : null, item.direction === "out" ? Number(item.amount) : null, cashItemNote(item)]);
  }
  return rows;
}

export { money };
