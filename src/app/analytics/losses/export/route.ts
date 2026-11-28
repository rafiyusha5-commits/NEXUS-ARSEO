import { requireUser } from "@/lib/auth/access";
import { lossLineRows, parseLossParams, riskItemRows, type LossLine, type RiskReport } from "@/lib/analytics/losses";
import { createXlsx } from "@/lib/xlsx";

// Lines of losses for a period and the stock at risk today, as XLSX. The database refuses without reports.view and
// inventory.view and leaves every amount empty without prices.purchase.view, so the file never shows what the screen hides.
export async function GET(request: Request) {
  const { supabase } = await requireUser();
  const url = new URL(request.url);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const { from, to } = parseLossParams({ from: url.searchParams.get("from") ?? undefined, to: url.searchParams.get("to") ?? undefined }, today);
  const [lines, risk] = await Promise.all([
    supabase.rpc("loss_report_lines", { p_from: from, p_to: to }),
    supabase.rpc("loss_risk", { p_group: "bucket" }),
  ]);
  if (lines.error || risk.error) return new Response("Нет доступа к отчёту о потерях", { status: 403 });
  const buffer = createXlsx([
    { name: "Потери", rows: lossLineRows((lines.data ?? []) as LossLine[]) },
    { name: "Под риском", rows: riskItemRows(((risk.data as RiskReport | null)?.items ?? [])) },
  ]);
  return new Response(new Uint8Array(buffer), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="Nexus-losses-${from}-${to}.xlsx"`, "Cache-Control": "private, no-store" } });
}
