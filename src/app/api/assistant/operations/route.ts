import { createClient } from "@/lib/supabase/server";
import { operationError, parseOperationIntent } from "@/lib/agent/operations";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) return reply({ error: "Недопустимый источник запроса" }, 403);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return reply({ error: "Неверный формат" }, 415);
  if (process.env.AGENT_OPERATIONS_ENABLED !== "true") return reply({ error: "Подготовка операций пока выключена" }, 503);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return reply({ error: "Сессия истекла. Войдите снова" }, 401);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > 8192) return reply({ error: "Запрос слишком большой" }, 413);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    body = parsed as Record<string, unknown>;
    if (Object.keys(body).some(key => !["action", "id", "intent", "token"].includes(key)) || typeof body.id !== "string" || !uuid.test(body.id)) throw new Error();
  } catch { return reply({ error: "Неверный формат команды" }, 400); }
  if (body.action === "prepare") {
    const intent = parseOperationIntent(body.intent);
    if (!intent || body.token !== undefined) return reply({ error: "Уточните параметры операции" }, 400);
    const { error } = await supabase.rpc("prepare_assistant_operation", { p_request_id: body.id, p_kind: intent.kind, p_payload: intent.params });
    if (error) return reply({ error: operationError(error) }, 409);
  } else if (body.action === "confirm") {
    if (body.intent !== undefined || typeof body.token !== "string" || !uuid.test(body.token)) return reply({ error: "Сначала проверьте операцию" }, 400);
    const { data, error } = await supabase.rpc("confirm_assistant_operation", { p_request_id: body.id, p_review_token: body.token });
    return error ? reply({ error: operationError(error) }, 409) : reply(data);
  } else if (body.action !== "review" || body.intent !== undefined || body.token !== undefined) return reply({ error: "Неизвестное действие" }, 400);
  const { data, error } = await supabase.rpc("review_assistant_operation", { p_request_id: body.id });
  return error ? reply({ error: operationError(error) }, 409) : reply(data);
}
