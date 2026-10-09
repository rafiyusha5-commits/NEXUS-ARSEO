import { createClient } from "@/lib/supabase/server";
import { loadAgentConfig } from "@/lib/agent/config";
import { runWebAssistant, sessionPermissions } from "@/lib/agent/server/service";

export const maxDuration = 60;

const MAX_BODY_BYTES = 8_192;
const json = (body: Record<string, unknown>, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// Streams processing stages, then exactly one verified result or one safe error, as NDJSON.
// Unverified facts are never streamed: the answer appears only after fact checking.
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) return json({ ok: false, error: "Недопустимый источник запроса" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ ok: false, error: "Неверный формат запроса" }, 415);
  const length = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(length) || length > MAX_BODY_BYTES) return json({ ok: false, error: "Вопрос слишком длинный" }, 413);

  const config = loadAgentConfig();
  if (!config.enabled) return json({ ok: false, code: "AGENT_DISABLED", error: "Ассистент выключен" }, 503);

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return json({ ok: false, error: "Сессия истекла. Войдите снова" }, 401);
  const { data: profile } = await supabase.from("profiles").select("is_active,user_type").eq("id", user.id).maybeSingle();
  if (!profile?.is_active || profile.user_type !== "employee") return json({ ok: false, error: "Нет доступа" }, 403);
  if (!(await sessionPermissions(supabase)(["agent.use"])).has("agent.use")) return json({ ok: false, error: "Нет права пользоваться ассистентом" }, 403);

  let question: unknown;
  let conversationId: string | undefined;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return json({ ok: false, error: "Вопрос слишком длинный" }, 413);
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => key !== "question" && key !== "conversationId")) {
      return json({ ok: false, error: "Неверный формат запроса" }, 400);
    }
    const input = body as { question?: unknown; conversationId?: unknown };
    if (input.conversationId !== undefined && (typeof input.conversationId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.conversationId))) return json({ ok: false, error: "Неверная беседа" }, 400);
    conversationId = input.conversationId as string | undefined;
    question = input.question;
  } catch {
    return json({ ok: false, error: "Неверный формат запроса" }, 400);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: Record<string, unknown>) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        const outcome = await runWebAssistant(supabase, user.id, question, (label) => send({ type: "stage", label }), conversationId);
        if (outcome.ok) send({ type: "result", answer: outcome.answer, requestsUsed: outcome.requestsUsed, requestLimit: outcome.requestLimit });
        else send({ type: "error", code: outcome.code, message: outcome.message, refunded: outcome.refunded });
      } catch {
        send({ type: "error", code: "AGENT_INTERNAL", message: "Не удалось обработать вопрос. Повторите попытку.", refunded: false });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
