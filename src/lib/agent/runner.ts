// Channel-neutral assistant run. The web route (and later Telegram) only supplies dependencies:
// the user's session data source, a fresh permission check, the ledger and the model provider.
import { actualCostMicros, reserveCostMicros, type AgentLimits } from "./config.ts";
import { ANSWER_JSON_SCHEMA, parseAnswer, verifyAnswer, type CallRecord } from "./facts.ts";
import { hasLongDigitChain, maskOutgoing, maskSensitive, prepareQuestion, traceExcerpt } from "./masking.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import { parseArguments, toJsonSchema, validateParams } from "./schema.ts";
import { AGENT_TOOLS, TOOL_BY_NAME } from "./tools.ts";
import {
  ProviderError, type AgentAnswer, type AgentDataSource, type AgentLedger, type AgentModelProvider, type AgentTool,
  type ModelMessage, type Reservation, type ToolResult, type TraceEntry,
} from "./types.ts";

export type RunnerDeps = {
  channel: "web" | "telegram";
  userId: string;
  provider: AgentModelProvider;
  ledger: AgentLedger;
  data: AgentDataSource;
  /** Returns the subset of codes the user holds right now (my_permissions with the user's session). */
  permissions: (codes: readonly string[]) => Promise<ReadonlySet<string>>;
  limits: AgentLimits;
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  onStage?: (label: string) => void;
  now?: () => number;
};

export type RunOutcome =
  | { ok: true; answer: AgentAnswer; requestsUsed: number; requestLimit: number }
  | { ok: false; code: string; message: string; refunded: boolean };

export const ERROR_TEXT: Record<string, string> = {
  QUESTION_EMPTY: "Введите вопрос.",
  QUESTION_TOO_LONG: "Вопрос слишком длинный: не больше 1000 символов.",
  QUESTION_UNSAFE: "В вопросе слишком много персональных данных или секретов, его нельзя безопасно передать. Уберите номера документов, ключи и пароли.",
  AGENT_FORBIDDEN: "У вас нет права пользоваться ассистентом.",
  AGENT_DAILY_LIMIT: "Лимит вопросов на сегодня исчерпан (сутки по времени Казахстана).",
  AGENT_MONTHLY_BUDGET: "Месячный бюджет ассистента исчерпан или не настроен. Обратитесь к администратору.",
  AGENT_RUN_BUDGET_EXCEEDED: "Бюджет ассистента не настроен администратором.",
  AGENT_LEDGER_ERROR: "Не удалось зарезервировать запрос. Повторите попытку.",
  AGENT_TOKEN_LIMIT: "Вопрос требует слишком большого объёма данных. Уточните его.",
  AGENT_STEP_LIMIT: "Ассистент не успел подготовить ответ за допустимое число шагов. Уточните вопрос.",
  AGENT_TIMEOUT: "Ассистент не ответил вовремя. Вопрос не засчитан, повторите попытку.",
  AGENT_PROVIDER_ERROR: "Сервис модели недоступен. Вопрос не засчитан, повторите позже.",
  AGENT_BAD_ANSWER: "Ассистент вернул ответ в неверном формате. Вопрос не засчитан.",
  AGENT_INTERNAL_ERROR: "Не удалось обработать вопрос. Вопрос не засчитан, повторите попытку.",
};

export function errorText(code: string): string {
  return ERROR_TEXT[code] ?? "Не удалось обработать вопрос. Повторите попытку.";
}

const LEDGER_CODES = new Set(["AGENT_FORBIDDEN", "AGENT_DAILY_LIMIT", "AGENT_MONTHLY_BUDGET", "AGENT_RUN_BUDGET_EXCEEDED"]);
const TOOL_STAGE: Record<string, string> = {
  find_shipments: "Ищу поставки", get_shipment: "Читаю карточку поставки", get_shipment_vehicles: "Читаю автомобили поставки",
  get_shipment_documents: "Читаю документы поставки", get_document_extraction: "Читаю результаты распознавания",
  list_delayed_shipments: "Ищу задержки", get_stock_status: "Читаю остатки", get_my_tasks: "Читаю ваши задачи", get_help: "Открываю справку",
};
const MAX_TOOL_CONTENT = 12_000;
const MAX_TRACE_ENTRIES = 30;

function withTimeout<T>(ms: number, parent: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  parent.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("TOOL_TIMEOUT"));
    }, ms);
  });
  return Promise.race([work(controller.signal), timeout]).finally(() => {
    clearTimeout(timer);
    parent.removeEventListener("abort", onAbort);
  });
}

/** What the model sees from a tool: allow-listed values with row numbers, masked once more. */
export function toolContent(callId: string, tool: AgentTool, result: ToolResult): string {
  const rows = result.rows.map((row, index) => ({
    row: index,
    subject: maskOutgoing(row.subject),
    // Record identifier for follow-up tools (get_shipment and others); never shown to the user as text.
    ...(row.entity && row.entity.type !== "task" ? { [`${row.entity.type}_id`]: row.entity.id } : {}),
    ...Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, typeof value === "string" ? maskOutgoing(value) : value])),
  }));
  let payload = JSON.stringify({ call: callId, tool: tool.name, truncated: result.truncated, total: result.total, notes: result.notes, rows });
  while (payload.length > MAX_TOOL_CONTENT && rows.length) {
    rows.pop();
    payload = JSON.stringify({ call: callId, tool: tool.name, truncated: true, total: result.total, notes: result.notes, rows });
  }
  return payload;
}

function estimateTokens(messages: ModelMessage[]): number {
  const chars = messages.reduce((sum, message) => sum + (("content" in message && message.content) ? message.content.length : 0)
    + (message.role === "assistant" ? (message.toolCalls ?? []).reduce((acc, call) => acc + call.arguments.length + call.name.length, 0) : 0), 0);
  // Cyrillic is about two characters per token; add room for tool definitions and the schema.
  return Math.ceil(chars / 2) + 3_000;
}

function safeParams(params: Record<string, string | number>): Record<string, string | number> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => {
    if (typeof value !== "string") return [key, value];
    // A number that no rule recognised is not written to the trace at all.
    return [key, hasLongDigitChain(maskSensitive(value).text, 9) ? "[скрыто]" : maskOutgoing(value).slice(0, 60)];
  }));
}

export async function runAgent(rawQuestion: unknown, deps: RunnerDeps): Promise<RunOutcome> {
  const stage = (label: string) => deps.onStage?.(label);
  const now = deps.now ?? Date.now;
  const question = prepareQuestion(rawQuestion);
  if (!question.ok) return { ok: false, code: question.code, message: errorText(question.code), refunded: false };

  stage("Проверяю права");
  const granted = await deps.permissions(["agent.use"]);
  if (!granted.has("agent.use")) return { ok: false, code: "AGENT_FORBIDDEN", message: errorText("AGENT_FORBIDDEN"), refunded: false };

  let reservation: Reservation;
  try {
    reservation = await deps.ledger.reserve({ channel: deps.channel, questionExcerpt: traceExcerpt(question.text), reserveUsdMicros: reserveCostMicros(deps.limits, deps.pricing) });
  } catch (error) {
    const code = error instanceof Error && LEDGER_CODES.has(error.message) ? error.message : "AGENT_LEDGER_ERROR";
    return { ok: false, code, message: errorText(code), refunded: false };
  }

  const deadline = AbortSignal.timeout(deps.limits.runDeadlineMs);
  const usage = { inputTokens: 0, outputTokens: 0 };
  const trace: TraceEntry[] = [];
  const calls = new Map<string, CallRecord>();
  let steps = 0;
  let toolCalls = 0;
  let formatRetries = 0;

  let finished = false;
  const finish = async (status: "completed" | "failed", errorCode: string | null, refund: boolean) => {
    if (finished) return;
    finished = true;
    try {
      await deps.ledger.finish(reservation, {
        status, errorCode, refund, provider: deps.provider.name, model: deps.provider.model, steps, toolCalls,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, actualUsdMicros: actualCostMicros(usage, deps.pricing),
        // The database accepts at most 30 entries of a fixed shape (agent_clean_tools).
        tools: trace.slice(0, MAX_TRACE_ENTRIES).map((entry) => ({ ...entry, ms: Math.min(Math.max(Math.round(entry.ms), 0), 120_000) })),
      });
    } catch {
      // Accounting failure must not expose details. After the TTL the database charges the whole
      // reservation as an estimate; a later finish of the same run would reconcile it.
    }
  };
  const fail = async (code: string): Promise<RunOutcome> => {
    await finish("failed", code, true);
    return { ok: false, code, message: errorText(code), refunded: true };
  };

  // Anything unexpected after the reservation still closes the run: tokens are recorded and the
  // request is returned to the user.
  try {
    // Tools the user may call right now; the model never sees others, and each call is re-checked.
    const toolGrants = await deps.permissions([...new Set(AGENT_TOOLS.flatMap((tool) => tool.permissions))]);
    const visibleTools = AGENT_TOOLS.filter((tool) => tool.permissions.every((code) => toolGrants.has(code)));
    const toolSpecs = visibleTools.map((tool) => ({ name: tool.name, description: tool.description, parameters: toJsonSchema(tool.params) }));

    const messages: ModelMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage(question.text) },
    ];

    while (steps < deps.limits.maxSteps) {
      if (deadline.aborted) return fail("AGENT_TIMEOUT");
      const estimate = estimateTokens(messages);
      if (usage.inputTokens + estimate > deps.limits.maxInputTokensTotal) return fail("AGENT_TOKEN_LIMIT");
      const maxOutput = Math.min(deps.limits.maxOutputTokensPerCall, deps.limits.maxOutputTokensTotal - usage.outputTokens);
      if (maxOutput < 300) return fail("AGENT_TOKEN_LIMIT");

      steps += 1;
      stage(steps === 1 ? "Разбираю вопрос" : "Анализирую данные");
      let response;
      try {
        response = await deps.provider.complete({
          messages, tools: toolSpecs, answerSchema: ANSWER_JSON_SCHEMA, maxOutputTokens: maxOutput,
          signal: AbortSignal.any([deadline, AbortSignal.timeout(deps.limits.providerTimeoutMs)]),
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          usage.inputTokens += error.usage.inputTokens;
          usage.outputTokens += error.usage.outputTokens;
          return fail(error.code === "AGENT_TIMEOUT" ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
        }
        return fail(deadline.aborted ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
      }
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;

      if (response.toolCalls.length) {
        // The model's own turn is sent back on the next step; mask it like any other outgoing text.
        messages.push({
          role: "assistant",
          content: response.content === null ? null : maskOutgoing(response.content),
          toolCalls: response.toolCalls.map((call) => ({ ...call, arguments: maskOutgoing(call.arguments) })),
        });
        for (const call of response.toolCalls) {
          const tool = TOOL_BY_NAME.get(call.name);
          const reply = (content: string) => messages.push({ role: "tool", toolCallId: call.id, content });
          if (toolCalls >= deps.limits.maxToolCalls) {
            reply(JSON.stringify({ call: call.id, error: "TOOL_CALL_LIMIT", message: "Лимит обращений к данным исчерпан. Дай ответ по уже полученным данным." }));
            trace.push({ name: tool?.name ?? "unknown", params: {}, rows: 0, truncated: false, ms: 0, error: "TOOL_CALL_LIMIT" });
            continue;
          }
          toolCalls += 1;
          if (!tool) {
            reply(JSON.stringify({ call: call.id, error: "UNKNOWN_TOOL" }));
            trace.push({ name: "unknown", params: {}, rows: 0, truncated: false, ms: 0, error: "UNKNOWN_TOOL" });
            continue;
          }
          const parsed = validateParams(tool.params, parseArguments(call.arguments));
          if (!parsed.ok) {
            reply(JSON.stringify({ call: call.id, error: "INVALID_PARAMS" }));
            trace.push({ name: tool.name, params: {}, rows: 0, truncated: false, ms: 0, error: "INVALID_PARAMS" });
            continue;
          }
          // Permission check at call time, independent of what the model was offered.
          const current = await deps.permissions([...tool.permissions, "agent.use"]);
          if (!current.has("agent.use") || !tool.permissions.every((code) => current.has(code))) {
            reply(JSON.stringify({ call: call.id, error: "PERMISSION_DENIED", message: "У сотрудника нет прав на эти данные." }));
            trace.push({ name: tool.name, params: safeParams(parsed.value), rows: 0, truncated: false, ms: 0, error: "PERMISSION_DENIED" });
            continue;
          }
          stage(TOOL_STAGE[tool.name] ?? "Читаю данные");
          const toolStarted = now();
          try {
            const result = await withTimeout(tool.timeoutMs, deadline, (signal) => tool.run({ userId: deps.userId, data: deps.data, signal }, parsed.value));
            const bounded = { ...result, rows: result.rows.slice(0, tool.maxRows) };
            calls.set(call.id, { tool, result: bounded });
            reply(toolContent(call.id, tool, bounded));
            trace.push({ name: tool.name, params: safeParams(parsed.value), rows: bounded.rows.length, truncated: bounded.truncated, ms: now() - toolStarted });
          } catch (error) {
            const code = error instanceof Error && error.message === "TOOL_TIMEOUT" ? "TOOL_TIMEOUT" : "TOOL_ERROR";
            reply(JSON.stringify({ call: call.id, error: code, message: "Данные получить не удалось." }));
            trace.push({ name: tool.name, params: safeParams(parsed.value), rows: 0, truncated: false, ms: now() - toolStarted, error: code });
          }
        }
        continue;
      }

      stage("Проверяю факты");
      const raw = parseAnswer(response.content);
      if (!raw) {
        if (formatRetries < 1 && steps < deps.limits.maxSteps) {
          formatRetries += 1;
          messages.push({ role: "assistant", content: response.content ? maskOutgoing(response.content.slice(0, 2000)) : null });
          messages.push({ role: "user", content: "Ответ не соответствует JSON-схеме. Верни только JSON по схеме." });
          continue;
        }
        return fail("AGENT_BAD_ANSWER");
      }
      const answer = verifyAnswer(raw, calls);
      await finish("completed", null, false);
      return { ok: true, answer, requestsUsed: reservation.requestsUsed, requestLimit: reservation.requestLimit };
    }
    return fail("AGENT_STEP_LIMIT");
  } catch {
    return fail("AGENT_INTERNAL_ERROR");
  }
}
