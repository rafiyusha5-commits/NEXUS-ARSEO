import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  EXPENSE_STATUS_LABELS, describeGoodsRate, describePlanComparison, expenseActions, expensesWithdrawnAfter, isPreliminaryCalculation, planComparison,
} from "../../src/lib/finance/expenses.ts";

const SQL = readFileSync(new URL("../../supabase/migrations/202609278000_expense_cancel_costing.sql", import.meta.url), "utf8");
const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const SHIPMENT = "33333333-3333-4333-8333-333333333333";
const can = (status: string, permissions: string[], extra: { isPlanned?: boolean; createdBy?: string } = {}) =>
  expenseActions({ status, isPlanned: extra.isPlanned ?? false, createdBy: extra.createdBy ?? ME, userId: ME, permissions: new Set(permissions) });

describe("expense actions", () => {
  it("labels every status the database allows", () => {
    const allowed = /check\(status in \(([^)]*)\)\)/.exec(SQL)?.[1].match(/'(\w+)'/g)?.map((value) => value.slice(1, -1));
    assert.deepEqual(allowed, ["draft", "confirmed", "allocated", "paid", "cancelled", "reversed"]);
    for (const status of allowed ?? []) assert.ok(EXPENSE_STATUS_LABELS[status], status);
  });

  it("cancels before payment and reverses after it", () => {
    const manager = ["finance.manage", "finance.pay"];
    for (const status of ["draft", "confirmed", "allocated"]) {
      assert.equal(can(status, manager).cancel, true, status);
      assert.equal(can(status, manager).reverse, false, status);
    }
    assert.deepEqual([can("paid", manager).cancel, can("paid", manager).reverse], [false, true]);
    assert.equal(can("paid", ["finance.manage"]).reverse, false, "storno needs the payment permission too");
    for (const status of ["cancelled", "reversed"]) {
      assert.deepEqual(can(status, manager), { confirm: false, allocate: false, pay: false, cancel: false, reverse: false }, status);
    }
  });

  it("lets a logistician cancel only their own draft", () => {
    assert.equal(can("draft", ["finance.draft"]).cancel, true);
    assert.equal(can("draft", ["finance.draft"], { createdBy: OTHER }).cancel, false);
    assert.equal(can("confirmed", ["finance.draft"]).cancel, false);
    assert.equal(can("draft", []).cancel, false);
  });

  it("never offers to allocate a planned expense, and re-allocates a paid actual one", () => {
    assert.equal(can("confirmed", ["finance.manage"], { isPlanned: true }).allocate, false);
    assert.equal(can("confirmed", ["finance.manage"]).allocate, true);
    assert.equal(can("paid", ["finance.manage"]).allocate, true);
    assert.equal(can("paid", ["finance.manage"]).pay, false);
  });
});

describe("landed cost versions", () => {
  const calculation = { shipment_id: SHIPMENT, calculated_at: "2026-10-13T10:00:00Z" };
  it("counts expenses of the shipment withdrawn after the calculation", () => {
    assert.equal(expensesWithdrawnAfter(calculation, [
      { shipment_id: SHIPMENT, cancelled_at: "2026-10-13T10:00:01Z", reversed_at: null },
      { shipment_id: SHIPMENT, cancelled_at: null, reversed_at: "2026-10-14T08:00:00+05:00" },
      { shipment_id: SHIPMENT, cancelled_at: "2026-10-13T09:59:59Z", reversed_at: null },
      { shipment_id: OTHER, cancelled_at: "2026-10-15T00:00:00Z", reversed_at: null },
      { shipment_id: SHIPMENT, cancelled_at: null, reversed_at: null },
    ]), 2);
  });

  it("compares the plan with the actual expenses", () => {
    assert.equal(planComparison({ expenses_total: "60000.00", planned_expenses_total: null, planned_expenses_without_rate: 0 }), null);
    const over = planComparison({ expenses_total: "60000.00", planned_expenses_total: "50000.00", planned_expenses_without_rate: 1 });
    assert.deepEqual(over, { planned: 50000, deviation: 10000, withoutRate: 1 });
    assert.equal(describePlanComparison(over!, "KZT"),
      `план расходов ${(50000).toLocaleString("ru-RU")} KZT · факт выше плана на ${(10000).toLocaleString("ru-RU")} KZT · без курса не учтено плановых расходов: 1`);
    assert.equal(describePlanComparison(planComparison({ expenses_total: 40, planned_expenses_total: 50 })!, "EUR"), "план расходов 50 EUR · факт ниже плана на 10 EUR");
    assert.equal(describePlanComparison(planComparison({ expenses_total: 50, planned_expenses_total: 50 })!, "EUR"), "план расходов 50 EUR · факт совпал с планом");
    assert.equal(describePlanComparison(planComparison({ expenses_total: 50, planned_expenses_total: null, planned_expenses_without_rate: 2 })!, "EUR"),
      "без курса не учтено плановых расходов: 2");
  });
});

describe("rate of the purchase price in a calculation line", () => {
  it("names the rate, its day and why that day", () => {
    assert.equal(describeGoodsRate({ goods_rate: 500, goods_rate_date: "2026-09-24", goods_rate_basis: "receipt" }), "курс 500 на дату прихода 24.09.2026");
    assert.equal(describeGoodsRate({ goods_rate: "519.75", goods_rate_date: "2026-10-09", goods_rate_basis: "loading" }), "курс 519,75 на дату загрузки 09.10.2026");
    assert.equal(describeGoodsRate({ goods_rate: 550, goods_rate_date: "2026-10-14", goods_rate_basis: "calculation" }), "оценка: курс 550 на дату расчёта 14.10.2026");
    assert.equal(describeGoodsRate({ goods_rate: null, goods_rate_date: null, goods_rate_basis: "expense" }), "по оплате товара");
  });

  it("says nothing for a line calculated before the rule or with a malformed value", () => {
    assert.equal(describeGoodsRate({}), null);
    assert.equal(describeGoodsRate({ goods_rate: 0, goods_rate_date: "2026-10-14", goods_rate_basis: "receipt" }), null);
    assert.equal(describeGoodsRate({ goods_rate: 500, goods_rate_date: "14.10.2026", goods_rate_basis: "receipt" }), null);
    assert.equal(describeGoodsRate({ goods_rate: 500, goods_rate_date: "2026-10-14", goods_rate_basis: "today" }), null);
  });

  it("marks a calculation preliminary while some goods are priced at the calculation day", () => {
    assert.equal(isPreliminaryCalculation([{ goods_rate_basis: "receipt" }, { goods_rate_basis: "calculation" }]), true);
    assert.equal(isPreliminaryCalculation([{ goods_rate_basis: "receipt" }, { goods_rate_basis: "expense" }, { goods_rate_basis: null }]), false);
    assert.equal(isPreliminaryCalculation(null), false);
  });
});
