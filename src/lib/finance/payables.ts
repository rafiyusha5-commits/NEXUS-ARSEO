// Formatting of the payables register (202611170400). Amounts come as decimal strings and are never added across
// currencies.
export type PayableRow = {
  payee_id: string | null; payee: string | null; currency: string; accrued: string; paid: string; rest: string; advances?: string;
  open_expenses: number; no_due_date: number; nearest_due: string | null; overdue_amount: string; overdue_days: number | null;
};

export const expenseTypeLabel: Record<string, string> = {
  goods_cost: "Стоимость товара", transport: "Перевозка", logistics: "Логистика", broker_fee: "Брокер", customs_duty: "Пошлина",
  tax: "Налог", stickering: "Стикеровка", marking: "Маркировка", bank_fee: "Банк", promo: "Промо", return: "Возврат", other: "Прочее",
};
export const expenseStatusLabel: Record<string, string> = { confirmed: "Подтверждён", allocated: "Распределён", paid: "Оплачен" };

export function money(value: string | number | null | undefined, currency = "") {
  if (value == null) return "—";
  return `${Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ""}`;
}

/** Totals per currency: rest and overdue. Each currency stays separate. */
export function payableTotals(rows: PayableRow[]) {
  const totals = new Map<string, { currency: string; rest: number; overdue: number }>();
  for (const row of rows) {
    const total = totals.get(row.currency) ?? { currency: row.currency, rest: 0, overdue: 0 };
    total.rest += Number(row.rest);
    total.overdue += Number(row.overdue_amount);
    totals.set(row.currency, total);
  }
  return [...totals.values()].sort((left, right) => left.currency.localeCompare(right.currency));
}

export function payeeHref(payeeId: string | null) {
  return `/finance/payables/${payeeId ?? "none"}`;
}
