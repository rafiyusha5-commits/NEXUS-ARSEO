import { requireUser } from "@/lib/auth/access";
import { parseProfitParams, profitLineRows, type ProfitLine } from "@/lib/analytics/profitability";
import { createXlsx } from "@/lib/xlsx";

// Lines of the profitability report for a period, as XLSX. The database refuses without reports.view and
// prices.purchase.view, so the file is never produced with empty figures.
export async function GET(request: Request) {
  const { supabase } = await requireUser();
  const url = new URL(request.url);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const { from, to } = parseProfitParams({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined }, today);
  const { data, error } = await supabase.rpc("profitability_lines", { p_from: from, p_to: to });
  if (error) return new Response("Нет доступа к отчёту о прибыльности", { status: 403 });
  const buffer = createXlsx([{ name: "Прибыльность", rows: profitLineRows((data ?? []) as ProfitLine[]) }]);
  return new Response(new Uint8Array(buffer), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="Nexus-profitability-${from}-${to}.xlsx"`, "Cache-Control": "private, no-store" } });
}
