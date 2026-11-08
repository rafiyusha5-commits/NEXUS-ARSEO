import { requireUser } from "@/lib/auth/access";
import { exportCalculation } from "@/lib/replenishment/export";
import { parseWorkspace, uuid } from "@/lib/replenishment/workspace";
export async function GET(request: Request) {
  const { supabase } = await requireUser();
  const id = uuid(new URL(request.url).searchParams.get("run"));
  if (!id) return new Response("Выберите сохранённый расчёт", { status: 400 });
  const { data, error } = await supabase.rpc("replenishment_workspace", { p_run_id: id });
  if (error) return new Response("Расчёт недоступен", { status: 403 });
  const workspace = parseWorkspace(data);
  if (!workspace.snapshot || !workspace.fresh) return new Response("Исходные данные изменились — сохраните новый расчёт", { status: 409 });
  const buffer = exportCalculation(workspace.snapshot, id);
  return new Response(new Uint8Array(buffer), { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="Nexus-KZ-${workspace.snapshot.asOf}.xlsx"`, "Cache-Control": "private, no-store" } });
}
