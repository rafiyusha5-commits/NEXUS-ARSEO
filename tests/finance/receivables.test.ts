import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { money, sortByRisk, totalsByCurrency, type Aging, type ReceivableCustomer } from "../../src/lib/finance/receivables.ts";

const aging = (currency: string, balance: number, overdue = 0, days: number | null = null): Aging => ({
  currency, balance, not_due: Math.max(balance - overdue, 0), overdue, overdue_1_30: overdue, overdue_31_60: 0, overdue_61_90: 0,
  overdue_over_90: 0, max_days_overdue: days, oldest_due: null,
});
const customer = (name: string, rows: Aging[]): ReceivableCustomer => ({
  customer_id: name, customer: name, tax_id: null, credit_limit: null, limit_currency: null, deferral_days: null, aging: rows, last_act: null,
});

describe("receivables list", () => {
  const list = [
    customer("Бета", [aging("KZT", 1000)]),
    customer("Альфа", [aging("KZT", 500, 200, 40), aging("EUR", 10)]),
    customer("Гамма", [aging("KZT", -300)]),
    customer("Дельта", [aging("KZT", 5000, 100, 3)]),
  ];

  it("sums debts, overdue and advances per currency, tenge first", () => {
    assert.deepEqual(totalsByCurrency(list), [
      { currency: "KZT", debt: 6500, overdue: 300, advances: 300, overdueCustomers: 2 },
      { currency: "EUR", debt: 10, overdue: 0, advances: 0, overdueCustomers: 0 },
    ]);
  });

  it("puts the oldest overdue first, then the larger debt", () => {
    assert.deepEqual(sortByRisk(list).map(row => row.customer), ["Альфа", "Дельта", "Бета", "Гамма"]);
  });

  it("formats money with two decimals", () => {
    assert.equal(money(1234.5, "KZT").replace(/\s/g, " "), "1 234,50 KZT");
    assert.equal(money(null), "0,00");
  });
});
