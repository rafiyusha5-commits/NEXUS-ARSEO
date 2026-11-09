import { requireUser } from "@/lib/auth/access";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadAgentConfig } from "@/lib/agent/config";
import { OpenAiProvider } from "@/lib/agent/providers/openai";
import { createSupabaseLedger } from "@/lib/agent/server/supabase-ledger";
import { explainCalculation } from "@/lib/replenishment/explain";
import { calculate } from "@/lib/replenishment/calculate";
import { parseWorkspace, uuid } from "@/lib/replenishment/workspace";
export async function POST(request: Request) {
  // Cookie-authorized endpoint: reject cross-origin requests, even when they have a session.
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return new Response("Недопустимый источник", { status: 403 });
  const { supabase, user } = await requireUser();
  const run = uuid(new URL(request.url).searchParams.get("run"));
  if (!run) return new Response("Выберите расчёт", { status: 400 });
  const permission = await supabase.rpc("my_permissions", { p_codes: ["agent.use"] });
  if (permission.error || !Array.isArray(permission.data) || !permission.data.includes("agent.use")) return new Response("Нет доступа к ИИ", { status: 403 });
  const response = await supabase.rpc("replenishment_workspace", { p_run_id: run });
  if (response.error) return new Response("Нет доступа к расчёту", { status: 403 });
  const workspace = parseWorkspace(response.data);
  if (!workspace.fresh || !workspace.snapshot) return new Response("Сохраните актуальный расчёт", { status: 409 });
  const config = loadAgentConfig(); const admin = config.enabled ? createAdminClient() : null;
  if (!config.enabled || !admin) return new Response("ИИ-пояснения выключены. Таблица и основания расчёта доступны.", { status: 503 });
  try {
    const prose = await explainCalculation(calculate(workspace.snapshot), user.id, config, new OpenAiProvider(config), createSupabaseLedger(admin));
    // A slow response cannot restore revoked access or present old stock as current.
    const current = await supabase.rpc("replenishment_workspace", { p_run_id: run });
    if (current.error || !parseWorkspace(current.data).fresh) return new Response("Доступ или данные изменились", { status: 409 });
    return Response.json({ explanation: prose }, { headers: { "Cache-Control": "private, no-store" } });
  } catch { return new Response("Пояснение сейчас недоступно. Расчёт сохранён; автоматического повтора нет.", { status: 503 }); }
}
