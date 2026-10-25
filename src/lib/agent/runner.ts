// Channel-neutral assistant run. The web route (and later Telegram) only supplies dependencies:
// the user's session data source, a fresh permission check, the ledger and the model provider.
import { actualCostMicros, reserveCostMicros, type AgentLimits } from "./config.ts";
import { ANSWER_JSON_SCHEMA, parseAnswer, verifyAnswer, type CallRecord } from "./facts.ts";
import { maskOutgoing, prepareQuestion } from "./masking.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import { parseArguments, toJsonSchema, validateParams } from "./schema.ts";
import { AGENT_TOOLS, TOOL_BY_NAME, localDate } from "./tools.ts";
import { conversationMemory, referencesFromCalls, visibleReferences } from "./conversation.ts";
import { channelAllowsTool } from "./channels.ts";
import {
  ProviderError, type AgentAnswer, type AgentDataSource, type AgentLedger, type AgentModelProvider, type AgentTool,
  type ModelMessage, type Reservation, type ToolResult, type TraceEntry, type UsageMissing,
} from "./types.ts";

export type RunnerDeps = {
  operationsEnabled?: boolean;
  channel: "web" | "telegram";
  userId: string;
  /** Optional process-local conversation, scoped again by user and channel. */
  conversationKey?: string;
  provider: AgentModelProvider;
  ledger: AgentLedger;
  data: AgentDataSource;
  /** Returns the subset of codes the user holds right now (my_permissions with the user's session). */
  permissions: (codes: readonly string[]) => Promise<ReadonlySet<string>>;
  limits: AgentLimits;
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  onStage?: (label: string) => void;
  now?: () => number;
  questionPreparation?: { reserveUsdMicros: number; prepare: (signal: AbortSignal) => Promise<{ text: string; costUsdMicros: number; durationSeconds: number }> };
  /** Called once the run is reserved, e.g. to show the accounting run next to a Telegram update. */
  onReserved?: (runId: string) => Promise<void> | void;
};

export class QuestionPreparationError extends Error {
  readonly costUsdMicros: number;
  constructor(code: string, costUsdMicros = 0) { super(code); this.costUsdMicros = costUsdMicros; }
}

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
  search_system: "Ищу информацию в Nexus", get_system_record: "Читаю подробную карточку", find_products: "Ищу товары в справочнике", list_delayed_shipments: "Ищу задержки", get_stock_status: "Читаю остатки", get_my_tasks: "Читаю ваши задачи", get_help: "Открываю справку",
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
    ...(row.references ? { references: row.references } : {}),
    ...(row.entity?.type === "system" ? { section: row.entity.section, record_id: row.entity.id } : {}),
    ...(row.entity && row.entity.type !== "task" && row.entity.type !== "system" ? { [`${row.entity.type}_id`]: row.entity.id } : {}),
    ...Object.fromEntries(Object.entries(row.values).map(([key, value]) => [key, tool.fields.some(field => field.key === key && field.kind === "protected") ? "[доступно сотруднику; скрыто для модели]" : typeof value === "string" ? maskOutgoing(value) : value])),
  }));
  let payload = JSON.stringify({ call: callId, tool: tool.name, truncated: result.truncated, total: result.total, notes: result.notes, rows });
  while (payload.length > MAX_TOOL_CONTENT && rows.length) {
    rows.pop();
    payload = JSON.stringify({ call: callId, tool: tool.name, truncated: true, total: result.total, notes: result.notes, rows });
  }
  return payload;
}

function estimateTokens(messages: ModelMessage[], definitions?: unknown): number {
  const chars = messages.reduce((sum, message) => sum + (("content" in message && message.content) ? message.content.length : 0)
    + (message.role === "assistant" ? (message.toolCalls ?? []).reduce((acc, call) => acc + call.arguments.length + call.name.length, 0) : 0), 0);
  // Cyrillic is about two characters per token; add room for tool definitions and the schema.
  return Math.ceil(chars / 2) + (definitions ? Math.max(3000, Math.ceil(JSON.stringify(definitions).length / 2) + 1000) : 3000);
}

function safeParams(params: Record<string, string | number>): Record<string, string | number> {
  // Any model-controlled string (even an ID or enum) can encode document contents.
  // Retain no parameter values in persistent telemetry.
  void params;
  return {};
}

export async function runAgent(rawQuestion: unknown, deps: RunnerDeps): Promise<RunOutcome> {
  const stage = (label: string) => deps.onStage?.(label);
  const now = deps.now ?? Date.now;
  let question = prepareQuestion(rawQuestion);
  if (!question.ok) return { ok: false, code: question.code, message: errorText(question.code), refunded: false };

  stage("Проверяю права");
  const granted = await deps.permissions(["agent.use"]);
  if (!granted.has("agent.use")) return { ok: false, code: "AGENT_FORBIDDEN", message: errorText("AGENT_FORBIDDEN"), refunded: false };

  let reservation: Reservation;
  try {
    reservation = await deps.ledger.reserve({ userId: deps.userId, channel: deps.channel, questionExcerpt: "", reserveUsdMicros: reserveCostMicros(deps.limits, deps.pricing) + (deps.questionPreparation?.reserveUsdMicros ?? 0) });
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
  let preparationCost = 0;
  // Calls whose result or usage is unknown (timeout, lost connection, missing or invalid counters)
  // are charged and limited at their worst case.
  // `usage` holds only tokens the provider reported; it is what the trace records. `bounded` adds
  // the conservative estimate of every unknown counter and drives both the run's token limits and
  // the money charged, so an answer without usage can neither escape the limits nor be free.
  const bounded = { inputTokens: 0, outputTokens: 0 };
  const recordUsage = (reported: { inputTokens: number; outputTokens: number }, missing: UsageMissing, estimatedInput: number, maxOutput: number) => {
    if (!missing.input) usage.inputTokens += reported.inputTokens;
    if (!missing.output) usage.outputTokens += reported.outputTokens;
    bounded.inputTokens += missing.input ? estimatedInput : reported.inputTokens;
    bounded.outputTokens += missing.output ? maxOutput : reported.outputTokens;
  };

  let finished = false;
  const finish = async (status: "completed" | "failed", errorCode: string | null, refund: boolean) => {
    if (finished) return;
    finished = true;
    try {
      await deps.ledger.finish(reservation, {
        status, errorCode, refund, provider: deps.provider.name, model: deps.provider.model, steps, toolCalls,
        inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, actualUsdMicros: actualCostMicros(bounded, deps.pricing) + preparationCost,
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

  try {
    await deps.onReserved?.(reservation.runId);
  } catch {
    // Display only; never blocks the run.
  }

  // Anything unexpected after the reservation still closes the run: tokens are recorded and the
  // request is returned to the user.
  try {
    if (deps.questionPreparation) {
      stage("Распознаю голос");
      try {
        const prepared = await deps.questionPreparation.prepare(deadline);
        preparationCost = prepared.costUsdMicros;
        // One decimal: the database accepts 0–60 seconds with at most one decimal place.
        trace.push({ name: "speech_to_text", params: { duration_seconds: Math.min(60, Math.round(prepared.durationSeconds * 10) / 10) }, rows: 0, truncated: false, ms: 0 });
        question = prepareQuestion(prepared.text);
        if (!question.ok) return fail(question.code);
      } catch (error) {
        preparationCost = error instanceof QuestionPreparationError ? error.costUsdMicros : deps.questionPreparation.reserveUsdMicros;
        await finish("failed", "AGENT_SPEECH_ERROR", true);
        const reason = error instanceof QuestionPreparationError ? error.message : "VOICE_UNKNOWN";
        const messages: Record<string, string> = {
          VOICE_DOWNLOAD: "Не удалось скачать голосовое сообщение из Telegram. Отправьте запись ещё раз.",
          VOICE_FORMAT: "Формат голосового сообщения не удалось прочитать. Запишите новое голосовое прямо в Telegram.",
          VOICE_DURATION: "Голосовое сообщение должно длиться не больше 60 секунд.",
          VOICE_ACCESS: "Распознавание голоса недоступно: проверьте доступ ключа к аудио в настройках OpenAI.",
          VOICE_RATE_LIMIT: "Сервис распознавания ограничил запросы. Попробуйте позже.",
          VOICE_TIMEOUT: "Сервис распознавания не ответил вовремя. Отправьте голосовое ещё раз.",
          VOICE_EMPTY: "В записи не удалось разобрать слова. Запишите вопрос ещё раз.",
        };
        console.warn("NEXUS_VOICE_FAILURE", reason in messages ? reason : "VOICE_PROVIDER");
        return { ok: false, code: "AGENT_SPEECH_ERROR", message: messages[reason] ?? "Не удалось распознать голос. Попробуйте короткое сообщение или напишите вопрос текстом.", refunded: true };
      }
    }
    // Tools the user may call right now; the model never sees others, and each call is re-checked.
    const toolGrants = await deps.permissions([...new Set(AGENT_TOOLS.flatMap((tool) => [...tool.permissions, ...(tool.scope?.sections.flatMap(section => [...section.permissions, ...section.anyPermissions]) ?? [])]))]);
    const visibleTools = AGENT_TOOLS.filter((tool) => channelAllowsTool(deps.channel, tool.name) && tool.permissions.every((code) => toolGrants.has(code)) && (!tool.scope || tool.scope.sections.some(section => section.permissions.every(code => toolGrants.has(code)) && (!section.anyPermissions.length || section.anyPermissions.some(code => toolGrants.has(code))))));
    const toolSpecs = visibleTools.map((tool) => {
      const params = { ...tool.params };
      if (tool.scope) params[tool.scope.param] = { type: "enum", description: tool.params[tool.scope.param].description,
        values: tool.scope.sections.filter(section => section.permissions.every(code => toolGrants.has(code)) && (!section.anyPermissions.length || section.anyPermissions.some(code => toolGrants.has(code)))).map(section => section.key) };
      return { name: tool.name, description: tool.description, parameters: toJsonSchema(params) };
    });

    const contextKey = deps.conversationKey ? JSON.stringify([deps.userId, deps.channel, deps.conversationKey]) : null;
    let previous = contextKey ? conversationMemory.read(contextKey, now()) : [];
    const messages: ModelMessage[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\nТекущая дата Nexus (Asia/Aqtobe): ${localDate(new Date(now()))}.\nКанал: ${deps.channel}. Подготовка операций ${deps.operationsEnabled && deps.channel === "web" ? "включена" : "выключена: operation всегда null"}.` },
      { role: "user", content: userMessage(question.text) },
    ];

    while (steps < deps.limits.maxSteps) {
      if (deadline.aborted) return fail("AGENT_TIMEOUT");
      const visible = await visibleReferences(previous, deps.data, deps.permissions, deadline);
      if (steps && visible.length !== previous.length) return fail("AGENT_FORBIDDEN");
      previous = visible;
      const memoryMessage: ModelMessage[] = previous.length ? [{ role: "user", content:
        `Ранее обсуждавшиеся объекты (только ссылки, не факты). Прочитай данные заново инструментами; не делай выводов о содержимом по ссылке:\n${JSON.stringify(previous.map(({ section, id }) => ({ section, id })))}` }] : [];
      const outgoing = [messages[0], ...memoryMessage, ...messages.slice(1)];
      const estimate = estimateTokens(outgoing, { tools: toolSpecs, answerSchema: ANSWER_JSON_SCHEMA });
      if (bounded.inputTokens + estimate > deps.limits.maxInputTokensTotal) return fail("AGENT_TOKEN_LIMIT");
      const maxOutput = Math.min(deps.limits.maxOutputTokensPerCall, deps.limits.maxOutputTokensTotal - bounded.outputTokens);
      if (maxOutput < 300) return fail("AGENT_TOKEN_LIMIT");

      steps += 1;
      stage(steps === 1 ? "Разбираю вопрос" : "Анализирую данные");
      let response;
      // Re-authorize retained context before it crosses the provider boundary,
      // including retries and results not selected for the final answer.
      const accesses = [...previous.map(ref => ref.access), ...[...calls.values()].flatMap(call => call.access ? [call.access] : [])];
      const retainedRecords = [...calls.values()].flatMap(call => call.records ? [call.records] : []);
      if (retainedRecords.length && !await deps.data.verifySystemAccess(retainedRecords, deadline)) return fail("AGENT_FORBIDDEN");
      const fresh = await deps.permissions(["agent.use", ...accesses.flatMap(group => [...group.all, ...group.any])]);
      if (!fresh.has("agent.use") || accesses.some(group => !group.all.every(code => fresh.has(code)) || (group.any.length && !group.any.some(code => fresh.has(code))))) return fail("AGENT_FORBIDDEN");
      deadline.throwIfAborted();
      try {
        response = await deps.provider.complete({
          messages: outgoing, tools: toolSpecs, answerSchema: ANSWER_JSON_SCHEMA, maxOutputTokens: maxOutput,
          signal: AbortSignal.any([deadline, AbortSignal.timeout(deps.limits.providerTimeoutMs)]),
        });
      } catch (error) {
        // Reported counters are recorded; any counter the provider did not report validly (or the
        // whole call, when it may have been processed without an answer) is charged at its bound:
        // the estimated input and the whole output allowance of this call. The request itself is
        // returned to the employee; the money is not released.
        const known = error instanceof ProviderError;
        recordUsage(known ? error.usage : { inputTokens: 0, outputTokens: 0 }, known ? error.usageMissing : { input: true, output: true }, estimate, maxOutput);
        const code = known ? error.code : deadline.aborted ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR";
        return fail(code === "AGENT_TIMEOUT" ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
      }
      // A successful answer without a valid usage report is not free either.
      recordUsage(response.usage, response.usageMissing ?? { input: false, output: false }, estimate, maxOutput);

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
          if (!tool || !channelAllowsTool(deps.channel, call.name)) {
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
          const section = tool.scope?.sections.find(item => item.key === parsed.value[tool.scope!.param]);
          const required = [...tool.permissions, ...(section?.permissions ?? [])];
          const alternatives = section?.anyPermissions ?? [];
          const current = await deps.permissions([...required, ...alternatives, "agent.use"]);
          if (!current.has("agent.use") || !required.every(code => current.has(code)) || (tool.scope && !section) || (alternatives.length && !alternatives.some(code => current.has(code)))) {
            reply(JSON.stringify({ call: call.id, error: "PERMISSION_DENIED", message: "У сотрудника нет прав на эти данные." }));
            trace.push({ name: tool.name, params: safeParams(parsed.value), rows: 0, truncated: false, ms: 0, error: "PERMISSION_DENIED" });
            continue;
          }
          stage(TOOL_STAGE[tool.name] ?? "Читаю данные");
          const toolStarted = now();
          try {
            const result = await withTimeout(tool.timeoutMs, deadline, (signal) => tool.run({ userId: deps.userId, data: deps.data, signal }, parsed.value));
            const extra=result.requiredPermissions??[];
            if(extra.length) {
              const extraGrants=await deps.permissions(extra);
              if(!extra.every(code=>extraGrants.has(code))) throw new Error("PERMISSION_DENIED");
            }
            const bounded = { ...result, rows: result.rows.slice(0, tool.maxRows) };
            calls.set(call.id, { tool, result: bounded, access: { all: [...required,...extra,...alternatives.filter(code=>current.has(code))], any: [] }, ...(["find_drive_documents","get_drive_document"].includes(tool.name) ? { records:{section:tool.name === "get_drive_document" ? "drive_text" : "drive",ids:bounded.rows.map(row=>row.entity?.id??"").filter(Boolean),versions:Object.fromEntries(bounded.rows.filter(row=>row.entity?.id&&typeof row.values.source_modified_at === "string").map(row=>[row.entity!.id,String(row.values.source_modified_at)]))} } : {}), ...(tool.scope ? { records:{section:String(parsed.value.section),ids:bounded.rows.map(row=>String(row.values.record_id??"")).filter(Boolean)} } : {}) });
            if (tool.name === "get_return_cancellations" || tool.name === "get_return_options" || tool.name === "get_return_decisions") {
              const stored = calls.get(call.id)!;
              stored.records = { section: tool.name === "get_return_cancellations" ? "assistant_return_cancellations" : tool.name === "get_return_options" ? "assistant_returns" : "assistant_return_decisions", ids: [String(parsed.value.sale_id)] };
            }
            reply(toolContent(call.id, tool, bounded));
            trace.push({ name: tool.name, params: safeParams(parsed.value), rows: bounded.rows.length, truncated: bounded.truncated, ms: now() - toolStarted });
          } catch (error) {
            const code = error instanceof Error && error.message === "TOOL_TIMEOUT" ? "TOOL_TIMEOUT" : error instanceof Error && error.message === "PERMISSION_DENIED" ? "PERMISSION_DENIED" : "TOOL_ERROR";
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
          messages.push({ role: "user", content: "Ответ не соответствует JSON-схеме. Верни только JSON: не больше 12 facts, в каждом fields от 1 до 8; commentary не больше 6, text до 600 символов; limitations не больше 5, до 300 символов каждое. Только call,row,fields в факте; только kind,text в пояснении. Раздели большую карточку на несколько фактов." });
          continue;
        }
        return fail("AGENT_BAD_ANSWER");
      }
      const answer = verifyAnswer(raw, calls);
      // A command is untrusted input, not a verified fact. Only the web's explicit
      // review endpoint can prepare it; there is deliberately no execution tool.
      if (deps.channel !== "web" || !deps.operationsEnabled) delete answer.operationIntent;
      const requirements = [...previous.map(ref => ref.access), ...[...calls.values()].flatMap(call => call.access ? [call.access] : [])];
      const finalGrants = await deps.permissions(["agent.use", ...requirements.flatMap(group => [...group.all,...group.any])]);
      if (!finalGrants.has("agent.use") || requirements.some(group => !group.all.every(code => finalGrants.has(code)) || (group.any.length && !group.any.some(code => finalGrants.has(code))))) return fail("AGENT_FORBIDDEN");
      const records = [...previous.map(ref => ({ section: ref.section, ids: [ref.id], ...(ref.version ? { versions: { [ref.id]: ref.version } } : {}) })),
        ...[...calls.values()].flatMap(call => call.records ? [call.records] : [])];
      if(records.length && !await deps.data.verifySystemAccess(records,deadline)) return fail("AGENT_FORBIDDEN");
      answer.accessRequirements = requirements;
      answer.accessRecords = records;
      await finish("completed", null, false);
      if (contextKey) conversationMemory.append(contextKey, referencesFromCalls(calls.values()), now());
      return { ok: true, answer, requestsUsed: reservation.requestsUsed, requestLimit: reservation.requestLimit };
    }
    return fail("AGENT_STEP_LIMIT");
  } catch {
    return fail("AGENT_INTERNAL_ERROR");
  }
}
