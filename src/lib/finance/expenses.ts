// Display rules for shipment expenses and landed-cost versions. The database decides what enters the
// landed cost (only actual expenses); these helpers only explain it on the page.

export const EXPENSE_STATUS_LABELS: Readonly<Record<string, string>> = {
  draft: "Черновик", confirmed: "Подтверждён", allocated: "Распределён", paid: "Оплачен",
  cancelled: "Отменён", reversed: "Сторнирован",
};

export type ExpenseActionsInput = {
  status: string; isPlanned: boolean; createdBy: string | null; userId: string; permissions: ReadonlySet<string>;
};

/** Which buttons an expense row offers. The database checks the same rules again. */
export function expenseActions({ status, isPlanned, createdBy, userId, permissions }: ExpenseActionsInput) {
  const manage = permissions.has("finance.manage");
  const unpaid = status === "draft" || status === "confirmed" || status === "allocated";
  return {
    confirm: status === "draft",
    // Planned expenses are compared with the landed cost, not spread over it; a paid one may be re-allocated.
    allocate: !isPlanned && (status === "confirmed" || status === "allocated" || status === "paid"),
    pay: status === "allocated",
    cancel: unpaid && (manage || (permissions.has("finance.draft") && status === "draft" && createdBy === userId)),
    reverse: status === "paid" && manage && permissions.has("finance.pay"),
  };
}

export type ExpenseChange = { shipment_id: string | null; cancelled_at: string | null; reversed_at: string | null };

/** Number of the shipment's expenses cancelled or reversed after the version was calculated. */
export function expensesWithdrawnAfter(calculation: { shipment_id: string; calculated_at: string }, expenses: readonly ExpenseChange[]): number {
  const calculatedAt = Date.parse(calculation.calculated_at);
  return expenses.filter((expense) => expense.shipment_id === calculation.shipment_id
    && [expense.cancelled_at, expense.reversed_at].some((at) => at !== null && Date.parse(at) > calculatedAt)).length;
}

export type PlanComparison = { planned: number | null; deviation: number | null; withoutRate: number };

/** Planned additional expenses against the actual ones of a calculation; null when there was no plan at all. */
export function planComparison(calculation: {
  expenses_total: number | string; planned_expenses_total: number | string | null; planned_expenses_without_rate?: number | null;
}): PlanComparison | null {
  const withoutRate = Number(calculation.planned_expenses_without_rate ?? 0);
  if (calculation.planned_expenses_total === null && withoutRate === 0) return null;
  const planned = calculation.planned_expenses_total === null ? null : Number(calculation.planned_expenses_total);
  return { planned, deviation: planned === null ? null : Math.round((Number(calculation.expenses_total) - planned) * 100) / 100, withoutRate };
}

export function describePlanComparison(comparison: PlanComparison, currency: string): string {
  const money = (value: number) => `${value.toLocaleString("ru-RU")} ${currency}`.trim();
  const parts: string[] = [];
  if (comparison.planned !== null && comparison.deviation !== null) {
    parts.push(`план расходов ${money(comparison.planned)}`);
    parts.push(comparison.deviation === 0 ? "факт совпал с планом"
      : comparison.deviation > 0 ? `факт выше плана на ${money(comparison.deviation)}` : `факт ниже плана на ${money(-comparison.deviation)}`);
  }
  if (comparison.withoutRate > 0) parts.push(`без курса не учтено плановых расходов: ${comparison.withoutRate}`);
  return parts.join(" · ");
}

// How the purchase price of a calculation line was converted (audit 2026-10-13, finding Н9).
export type GoodsRateBasis = "expense" | "receipt" | "loading" | "calculation";
const GOODS_RATE_BASIS: Record<GoodsRateBasis, string> = {
  expense: "по оплате товара",
  receipt: "на дату прихода",
  loading: "на дату загрузки",
  calculation: "на дату расчёта",
};

export function describeGoodsRate(line: { goods_rate?: number | string | null; goods_rate_date?: string | null; goods_rate_basis?: string | null }): string | null {
  const basis = line.goods_rate_basis as GoodsRateBasis | null | undefined;
  if (!basis || !(basis in GOODS_RATE_BASIS)) return null;
  if (basis === "expense") return GOODS_RATE_BASIS.expense;
  const rate = Number(line.goods_rate);
  const day = line.goods_rate_date && /^\d{4}-\d{2}-\d{2}$/.test(line.goods_rate_date) ? line.goods_rate_date.split("-").reverse().join(".") : null;
  if (!Number.isFinite(rate) || rate <= 0 || !day) return null;
  const text = `курс ${rate.toLocaleString("ru-RU", { maximumFractionDigits: 6 })} ${GOODS_RATE_BASIS[basis]} ${day}`;
  return basis === "calculation" ? `оценка: ${text}` : text;
}

// A calculation is preliminary while some goods have neither arrived nor been loaded: their rate is that of the calculation day.
export function isPreliminaryCalculation(lines: readonly { goods_rate_basis?: string | null }[] | null | undefined): boolean {
  return (lines ?? []).some((line) => line.goods_rate_basis === "calculation");
}
