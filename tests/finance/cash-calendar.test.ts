import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  calendarRows, cashItemHref, cashItemNote, cellHref, dayAfter, gapText, itemRows, parseCashParams, periodLabel, planFactRows, staleBalanceText, weekStart,
  type CashCalendar, type CashCurrency, type CashItem,
} from "../../src/lib/finance/cash-calendar.ts";

const CUR = "11111111-1111-4111-8111-111111111111";
const CUSTOMER = "22222222-2222-4222-8222-222222222222";
const SALE = "33333333-3333-4333-8333-333333333333";
const period = (start: string, end: string, closing: string | null, gap = false) => ({
  start, end, in_receivables: "300000.00", in_orders: "0", out_payables: "1200000.00", out_planned: "0", closing, closing_with_plan: closing,
  closing_kzt: closing, gap, gap_with_plan: gap,
});
const currency = (patch: Partial<CashCurrency> = {}): CashCurrency => ({
  currency_id: CUR, currency: "KZT", rate_kzt: "1",
  opening: { amount: "1000000.00", as_of: "2026-11-28", accounts: 1, accounts_without_balance: 0, list: [] },
  overdue_in: "200000.00", overdue_out: "50000.00", no_date_out: "70000.00", later_in: "0", later_orders: "0", later_out: "0", later_planned: "0",
  orders_with_unpriced: 0, advances: "0", overpayments: "50000.00", first_gap: "2026-12-10", first_gap_with_plan: "2026-12-10",
  periods: [period("2026-11-23", "2026-11-29", "700000.00"), period("2026-12-07", "2026-12-13", "-200000.00", true)], ...patch,
});
const calendar = (patch: Partial<CashCalendar> = {}): CashCalendar => ({
  today: "2026-11-28", step: "week", from: "2026-11-23", to: "2026-02-21", receivables: true, goods: true, can_manage: true, gap_alert_days: 14,
  currencies: [currency()], ...patch,
});

describe("payment calendar: parameters", () => {
  it("13 weeks by default, 14 days for the day step; anything else falls back", () => {
    assert.deepEqual(parseCashParams({}), { step: "week", periods: 13, view: "calendar", currency: null, bucket: null, from: null, to: null });
    assert.equal(parseCashParams({ step: "day" }).periods, 14);
    const items = parseCashParams({ view: "items", currency: CUR, bucket: "period", from: "2026-12-01", to: "2026-12-07" });
    assert.deepEqual([items.view, items.currency, items.bucket, items.from, items.to], ["items", CUR, "period", "2026-12-01", "2026-12-07"]);
    const bad = parseCashParams({ view: "drop", currency: "../admin", bucket: "all", from: "1.12.2026", step: "month" });
    assert.deepEqual([bad.view, bad.currency, bad.bucket, bad.from, bad.step], ["calendar", null, null, null, "week"]);
  });

  it("links to a cell carry only ids, a bucket and dates", () => {
    assert.equal(cellHref({ step: "week", currency: CUR, bucket: "period", from: "2026-12-07", to: "2026-12-13" }),
      `/finance/cash?view=items&step=week&currency=${CUR}&bucket=period&from=2026-12-07&to=2026-12-13`);
    assert.equal(cellHref({ step: "day", currency: CUR, bucket: "no_date" }), `/finance/cash?view=items&step=day&currency=${CUR}&bucket=no_date`);
    assert.equal(dayAfter("2026-12-31"), "2027-01-01");
  });
});

describe("payment calendar: wording", () => {
  it("names the gap in words with its week; an unknown balance claims no gap", () => {
    assert.equal(gapText(currency()), "Кассовый разрыв в KZT с 10.12.2026 (неделя с 07.12.2026)");
    assert.equal(gapText(currency({ first_gap: null, first_gap_with_plan: "2026-12-20" })), "Разрыва по подтверждённым суммам нет; с учётом плана — с 20.12.2026");
    assert.equal(gapText(currency({ first_gap: null, first_gap_with_plan: null })), "Кассового разрыва в KZT в горизонте нет");
    assert.match(gapText(currency({ opening: { amount: null, as_of: null, accounts: 0, accounts_without_balance: 0, list: [] } })), /не введён: разрыв не определяется/);
    assert.match(gapText(currency({ opening: { amount: null, as_of: null, accounts: 2, accounts_without_balance: 1, list: [] } })), /не по всем счетам/);
    assert.equal(weekStart("2026-11-29"), "2026-11-23");
    assert.equal(weekStart("2026-11-23"), "2026-11-23");
  });

  it("warns about a stale balance after three days", () => {
    const opening = currency().opening;
    assert.equal(staleBalanceText({ ...opening, as_of: "2026-11-25" }, "2026-11-28"), null);
    assert.match(staleBalanceText({ ...opening, as_of: "2026-11-20" }, "2026-11-28") ?? "", /8 дн\. назад/);
    assert.equal(staleBalanceText({ ...opening, as_of: null }, "2026-11-28"), null);
  });

  it("labels periods and lines, links lines to their screens", () => {
    assert.equal(periodLabel({ start: "2026-11-23", end: "2026-11-29" }, "week"), "23.11.2026 — 29.11.2026");
    assert.match(periodLabel({ start: "2026-11-28", end: "2026-11-28" }, "day"), /^28\.11, /);
    const item = (patch: Partial<CashItem>): CashItem => ({ kind: "payable", direction: "out", ref_type: "expense", ref_id: SALE, ref_label: "Перевозчик",
      counterparty_id: CUSTOMER, date: "2026-12-10", due_date: "2026-12-03", amount: "1200000.00", note: "logistics", ...patch });
    assert.equal(cashItemHref(item({})), `/finance/payables/${CUSTOMER}`);
    assert.equal(cashItemHref(item({ counterparty_id: null })), "/finance/payables/none");
    assert.equal(cashItemHref(item({ kind: "receivable", direction: "in" })), `/finance/receivables/${CUSTOMER}`);
    assert.equal(cashItemHref(item({ kind: "order", direction: "in" })), `/sales/${SALE}`);
    assert.equal(cashItemHref(item({ kind: "receivable", counterparty_id: "javascript:alert(1)" })), null);
    assert.equal(cashItemNote(item({})), "Логистика");
    assert.match(cashItemNote(item({ kind: "order", note: "unpriced_lines:2" })), /строк без цены: 2/);
  });
});

describe("payment calendar: XLSX", () => {
  it("keeps currencies apart, marks the gap and the lines outside the periods", () => {
    const rows = calendarRows(calendar({ goods: false, currencies: [currency(), currency({ currency: "EUR", rate_kzt: null, first_gap: null, first_gap_with_plan: null })] }));
    const text = rows.map(row => row.join("|")).join("\n");
    assert.match(text, /оплаты за товар не показаны/);
    assert.match(text, /Валюта KZT[\s\S]*Кассовый разрыв в KZT[\s\S]*кассовый разрыв[\s\S]*Валюта EUR/);
    assert.match(text, /Просрочено \(не разнесено по неделям\)\|200000\|\|50000/);
    assert.match(text, /Срок оплаты не задан\|\|\|70000/);
    assert.match(text, /Справочно: переплаты к возврату\|50000/);
    assert.match(text, /Нет официального курса EUR/);
    assert.ok(!rows.some(row => row.length > 1 && row[0] === "Итого"), "never a total across currencies");
  });

  it("plan-fact and lines", () => {
    const plan = planFactRows({ from: "2026-10-26", to: "2026-11-22", receivables: true, goods: true,
      currencies: [{ currency: "KZT", weeks: [{ start: "2026-11-16", end: "2026-11-22", plan_in: "300000", fact_in: "340000", plan_out: "50000", fact_out: "160000" }] }] });
    assert.deepEqual(plan.at(-1), ["16.11.2026 — 22.11.2026", 300000, 340000, 50000, 160000]);
    const lines = itemRows("KZT", "просрочено", { total: 600, limit: 500, amount_in: "1", amount_out: "0", items: [
      { kind: "receivable", direction: "in", ref_type: "customer", ref_id: CUSTOMER, ref_label: "Должник", counterparty_id: CUSTOMER, date: "2026-11-08", due_date: "2026-11-08", amount: "150000.00", note: null }] });
    assert.equal(lines[0][2], "показаны первые 1");
    assert.deepEqual(lines[2], ["Долг клиента", "Должник", "08.11.2026", "08.11.2026", 150000, null, ""]);
  });
});
