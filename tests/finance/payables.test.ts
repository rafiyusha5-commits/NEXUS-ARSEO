import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { money, payableTotals, payeeHref, type PayableRow } from "../../src/lib/finance/payables.ts";

const row = (currency: string, rest: string, overdue: string): PayableRow => ({
  payee_id: null, payee: null, currency, accrued: rest, paid: "0", rest, open_expenses: 1, no_due_date: 0,
  nearest_due: null, overdue_amount: overdue, overdue_days: Number(overdue) > 0 ? 3 : null,
});

describe("payables register", () => {
  it("never adds amounts of different currencies", () => {
    assert.deepEqual(payableTotals([row("KZT", "60000.00", "60000.00"), row("EUR", "50.00", "0"), row("KZT", "100.50", "0")]),
      [{ currency: "EUR", rest: 50, overdue: 0 }, { currency: "KZT", rest: 60100.5, overdue: 60000 }]);
  });
  it("links a payee card, and expenses without a payee to their own card", () => {
    assert.equal(payeeHref("d4100000-0000-4000-8000-000000000002"), "/finance/payables/d4100000-0000-4000-8000-000000000002");
    assert.equal(payeeHref(null), "/finance/payables/none");
  });
  it("shows a missing amount as a dash, not zero", () => {
    assert.equal(money(null), "—");
    assert.match(money("1234.5", "EUR"), /^1\s?234,50 EUR$/);
  });
});
