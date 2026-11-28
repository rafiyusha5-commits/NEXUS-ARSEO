import { requireUser } from "@/lib/auth/access";
import { calendarRows, dayAfter, itemRows, parseCashParams, planFactRows, type CashCalendar, type CashCell, type CashPlanFact } from "@/lib/finance/cash-calendar";
import { createXlsx, type XlsxCell } from "@/lib/xlsx";

// The payment calendar as XLSX: the calendar, plan and fact of eight past weeks, and the lines of every currency (the first
// 500 of each group). The database applies the employee's rights, so a file without purchase prices has no goods payments.
export async function GET(request: Request) {
  const { supabase } = await requireUser();
  const url = new URL(request.url);
  const params = parseCashParams({ step: url.searchParams.get("step") ?? undefined });
  const [{ data, error }, { data: planFact, error: planError }] = await Promise.all([
    supabase.rpc("cash_calendar", { p_step: params.step, p_periods: params.periods }),
    supabase.rpc("cash_plan_fact", { p_weeks: 8 }),
  ]);
  if (error || planError || !data) return new Response("Нет доступа к платёжному календарю", { status: 403 });
  const calendar = data as CashCalendar;
  const lines: XlsxCell[][] = [];
  for (const currency of calendar.currencies) {
    const groups = [
      { title: "просрочено", bucket: "overdue", from: null, to: null },
      { title: `${calendar.from} — ${calendar.to}`, bucket: "period", from: calendar.from, to: calendar.to },
      { title: `после ${calendar.to}`, bucket: "later", from: dayAfter(calendar.to), to: null },
      { title: "срок оплаты не задан", bucket: "no_date", from: null, to: null },
    ] as const;
    for (const group of groups) {
      const { data: cell, error: cellError } = await supabase.rpc("cash_calendar_items", { p_currency_id: currency.currency_id, p_bucket: group.bucket, p_from: group.from, p_to: group.to });
      if (cellError) return new Response("Нет доступа к платёжному календарю", { status: 403 });
      if ((cell as CashCell).total) lines.push(...itemRows(currency.currency, group.title, cell as CashCell), []);
    }
  }
  const buffer = createXlsx([
    { name: "Календарь", rows: calendarRows(calendar) },
    { name: "План-факт", rows: planFactRows(planFact as CashPlanFact) },
    { name: "Строки", rows: lines.length ? lines : [["Строк нет"]] },
  ]);
  return new Response(new Uint8Array(buffer), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="Nexus-cash-calendar-${calendar.today}.xlsx"`, "Cache-Control": "private, no-store" } });
}
