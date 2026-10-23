// Shapes returned by the receivables RPCs and small helpers for the pages.

export type Aging = {
  currency: string; balance: number; not_due: number; overdue: number; overdue_1_30: number; overdue_31_60: number;
  overdue_61_90: number; overdue_over_90: number; max_days_overdue: number | null; oldest_due: string | null;
};
export type ReceivableCustomer = {
  customer_id: string; customer: string; tax_id: string | null; credit_limit: number | null; limit_currency: string | null;
  deferral_days: number | null; aging: Aging[]; last_act: { as_of: string; difference: number; currency: string } | null;
};
export type LedgerEntry = {
  entry_date: string; due_date: string; kind: string; ref_id: string; ref_number: string | null; currency: string;
  amount: number; description: string; running: number;
};
export type ReconciliationAct = { id: string; as_of: string; currency: string; act_balance: number; nexus_balance: number; difference: number; note: string | null };
export type CustomerStatement = {
  customer_id: string; customer: string; legal_name: string; tax_id: string | null; credit_limit: number | null;
  limit_currency: string | null; deferral_days: number | null; today: string; aging: Aging[]; entries: LedgerEntry[]; acts: ReconciliationAct[];
};
export type CreditIssue = { code: "overdue" | "limit"; currency: string; amount: number; message: string };
export type CreditCheck = {
  issues: CreditIssue[]; aging: Aging[]; order_amount: number; order_currency: string;
  decisions: { reason: string; decided_at: string; decided_by: string | null; issues: CreditIssue[] }[];
};

export const ENTRY_KIND: Record<string, string> = {
  opening: "Сальдо 1С", shipment: "Отгрузка", return: "Возврат", payment: "Оплата", adjustment: "Корректировка",
};
export const LINE_STATUS: Record<string, string> = { unmatched: "Не разнесён", matched: "Разнесён", ignored: "Не покупатель" };
export const MATCHED_HOW: Record<string, string> = { auto_bin: "по БИН", auto_order: "по номеру заказа", manual: "вручную" };

export function money(value: number | string | null | undefined, currency?: string | null) {
  const amount = Number(value ?? 0).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${amount} ${currency}` : amount;
}

// Totals of the whole list per currency: who owes, how much is late and how much was paid in advance.
export function totalsByCurrency(customers: ReceivableCustomer[]) {
  const totals = new Map<string, { currency: string; debt: number; overdue: number; advances: number; overdueCustomers: number }>();
  for (const customer of customers) {
    for (const row of customer.aging) {
      const total = totals.get(row.currency) ?? { currency: row.currency, debt: 0, overdue: 0, advances: 0, overdueCustomers: 0 };
      const balance = Number(row.balance);
      if (balance > 0) total.debt += balance; else total.advances -= balance;
      total.overdue += Number(row.overdue);
      if (Number(row.overdue) > 0) total.overdueCustomers += 1;
      totals.set(row.currency, total);
    }
  }
  const round = (value: number) => Math.round(value * 100) / 100;
  return [...totals.values()]
    .map(total => ({ ...total, debt: round(total.debt), overdue: round(total.overdue), advances: round(total.advances) }))
    .sort((left, right) => (left.currency === "KZT" ? -1 : right.currency === "KZT" ? 1 : left.currency.localeCompare(right.currency)));
}

// Customers with overdue debt first (oldest first), then by the size of the debt.
export function sortByRisk(customers: ReceivableCustomer[]) {
  const days = (customer: ReceivableCustomer) => Math.max(0, ...customer.aging.map(row => Number(row.max_days_overdue ?? 0)));
  const debt = (customer: ReceivableCustomer) => customer.aging.reduce((sum, row) => sum + Math.max(0, Number(row.balance)), 0);
  return [...customers].sort((left, right) => days(right) - days(left) || debt(right) - debt(left) || left.customer.localeCompare(right.customer, "ru"));
}
