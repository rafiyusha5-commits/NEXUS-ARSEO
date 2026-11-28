import { requireUser } from "@/lib/auth/access";
import { reviewRows, type CountReview, type CountSheet } from "@/lib/inventory/counts";
import { createXlsx } from "@/lib/xlsx";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The report of a count as XLSX: totals, lines, sums by reason and by location. The database refuses before counting ends
// and, for a blind count, to anyone but the approver; money only with purchase prices.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuid.test(id)) return new Response("Не найдено", { status: 404 });
  const { supabase } = await requireUser();
  const [{ data: sheet, error: sheetError }, { data: review, error }] = await Promise.all([
    supabase.rpc("inventory_count_sheet", { p_count_id: id }),
    supabase.rpc("inventory_count_review", { p_count_id: id }),
  ]);
  if (sheetError || error || !sheet || !review) return new Response("Отчёт недоступен", { status: 403 });
  const value = sheet as CountSheet;
  const buffer = createXlsx([{ name: "Инвентаризация", rows: reviewRows(value, review as CountReview) }]);
  return new Response(new Uint8Array(buffer), { headers: {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="Nexus-count-${encodeURIComponent(value.number)}.xlsx"`, "Cache-Control": "private, no-store" } });
}
