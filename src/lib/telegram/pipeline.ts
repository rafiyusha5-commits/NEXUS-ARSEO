// One Telegram message, end to end. Pure module: every external system is injected, so failures at
// each step (session, voice download, transcription, model, Telegram) are tested with fakes.
//
// Rules:
// - An update is claimed in the database before anything paid happens; a repeated delivery, a
//   restarted or a second worker never runs the model or charges the budget again.
// - Nothing is retried automatically. When the result is unknown the state says so in Nexus.
// - Business data reaches the chat only if the employee still has access right before sending.
// - The temporary employee session is always closed (scope "local"), also after a timeout.
import type { AgentLimits } from "../agent/config.ts";
import { maskDataText } from "../agent/masking.ts";
import { QuestionPreparationError, runAgent } from "../agent/runner.ts";
import type { AgentDataSource, AgentLedger, AgentModelProvider } from "../agent/types.ts";
import { TelegramError, type TelegramBot } from "./client.ts";
import { telegramAnswer } from "./format.ts";
import { privateMessage, shortMessage, startCode } from "./protocol.ts";
import { MAX_VOICE_BYTES, SPEECH_RESERVE_MICROS, readBounded, voiceInput } from "./speech.ts";

/** Whole processing of one message, below the route's maxDuration (90 s) and the worker's timeout. */
export const TELEGRAM_DEADLINE_MS = 75_000;
/** Kept free at the end for the access re-check and sendMessage. */
export const SEND_RESERVE_MS = 15_000;
/** A question is not started (and nothing reserved) with less time than this left for the run. */
export const MIN_RUN_MS = 20_000;
const SEND_TIMEOUT_MS = 10_000;

export type EmployeeSession = {
  permissions: (codes: readonly string[]) => Promise<ReadonlySet<string>>;
  data: AgentDataSource;
  usage: () => Promise<{ used: number; limit: number }>;
  close: () => Promise<void>;
};

export type TelegramAgent = {
  provider: AgentModelProvider;
  ledger: AgentLedger;
  limits: AgentLimits;
  pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number };
  transcribe: (audio: Uint8Array, signal: AbortSignal) => Promise<{ text: string; costUsdMicros: number; durationSeconds: number }>;
};

export type TelegramPipelineDeps = {
  /** Service RPCs telegram_* only (server key); never business data. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  bot: TelegramBot;
  /** Temporary Auth session of the employee; business data is read only through it. */
  openSession: (userId: string, signal: AbortSignal) => Promise<EmployeeSession>;
  /** null when the assistant is disabled. */
  agent: () => TelegramAgent | null;
  voiceEnabled: boolean;
  deadlineMs?: number;
  now?: () => number;
};

type Stage = "session" | "speech" | "model" | "access_check" | "sending";

export const TELEGRAM_TEXT = {
  linkRequested: "Запрос привязки получен. Вернитесь в Nexus → Ассистент → Telegram, обновите страницу и подтвердите этот чат.",
  linkInvalid: "Ссылка недействительна или истекла. Создайте новую ссылку в Nexus.",
  unlinked: "Telegram отключён от Nexus.",
  help: "Nexus ARSEO. Для доступа откройте Nexus → Ассистент → Telegram и привяжите этот личный чат. После подтверждения задавайте вопросы текстом или голосом до 60 секунд. /limit — остаток вопросов, /unlink — отключить чат. Файлы пока не поддерживаются.",
  notLinked: "Этот чат не привязан или доступ отозван. Подключите Telegram в Nexus → Ассистент → Telegram.",
  voiceRules: "Для голосового вопроса отправьте запись до 60 секунд и до 1 МБ. Если голос выключен в Nexus, напишите текстом.",
  unsupported: "Задайте вопрос текстом или голосом до 60 секунд. Доступные команды: /help, /limit, /unlink. Файлы пока не поддерживаются.",
  disabled: "Ассистент выключен в Nexus.",
  noTime: "Сообщение обработать не успели. Вопрос не засчитан, отправьте его ещё раз.",
  withheld: "Доступ к ассистенту отозван или привязка изменена. Ответ не отправлен.",
  failed: "Не удалось обработать сообщение. Повторите вопрос или откройте Nexus.",
} as const;

class StepTimeout extends Error {
  constructor() { super("TELEGRAM_DEADLINE"); }
}

/**
 * Waits for `work` at most `ms`. A value that arrives too late is handed to `late` (used to close a
 * session that was opened after its caller gave up) instead of being leaked.
 */
async function within<T>(work: Promise<T>, ms: number, late?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new StepTimeout()); }, Math.max(0, ms));
  });
  work.then((value) => { if (timedOut) late?.(value); }, () => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function processTelegramMessage(update: unknown, deps: TelegramPipelineDeps): Promise<void> {
  const message = privateMessage(update);
  if (!message) return;
  // A failure here throws to the caller: nothing was claimed, so the worker may deliver it again.
  const claim = await deps.rpc("telegram_claim_update", { p_update_id: message.updateId, p_chat_id: message.chatId });
  // Already claimed by an earlier delivery, a restarted or a parallel worker: never run it again.
  if (typeof claim !== "string") return;

  const now = deps.now ?? Date.now;
  const started = now();
  const budget = deps.deadlineMs ?? TELEGRAM_DEADLINE_MS;
  const remaining = () => budget - (now() - started);
  const deadline = AbortSignal.timeout(Math.max(1, budget));
  let userId: string | null = null;
  // Display only: a lost progress write must never change what happens to the message.
  const progress = (stage: Stage, extra: { runId?: string; error?: string } = {}) => deps.rpc("telegram_update_progress", {
    p_update_id: message.updateId, p_token: claim, p_stage: stage, p_user_id: userId, p_run_id: extra.runId ?? null, p_error_code: extra.error ?? null,
  }).catch(() => false);
  const status = (value: "delivery_started" | "completed" | "failed" | "delivery_unknown") =>
    deps.rpc("telegram_update_status", { p_update_id: message.updateId, p_token: claim, p_status: value });

  let session: EmployeeSession | null = null;
  let closed = false;
  const closeSession = async () => {
    if (!session || closed) return;
    closed = true;
    await within(session.close(), 5_000).catch(() => undefined);
  };
  let reply: string;
  let errorCode: string | null = null;
  try {
    const code = message.text ? startCode(message.text) : null;
    if (code) {
      const linked = await within(deps.rpc("telegram_request_link", { p_code: code, p_chat_id: message.chatId, p_name: message.displayName }), remaining() - SEND_RESERVE_MS);
      reply = linked === true ? TELEGRAM_TEXT.linkRequested : TELEGRAM_TEXT.linkInvalid;
    } else if (message.text === "/unlink") {
      await within(deps.rpc("telegram_unlink_chat", { p_chat_id: message.chatId }), remaining() - SEND_RESERVE_MS);
      reply = TELEGRAM_TEXT.unlinked;
    } else if (message.text === "/help" || message.text === "/start") {
      reply = TELEGRAM_TEXT.help;
    } else {
      const employee = await within(deps.rpc("telegram_employee", { p_chat_id: message.chatId }), remaining() - SEND_RESERVE_MS);
      const voice = voiceInput(message.voice);
      if (typeof employee !== "string") reply = TELEGRAM_TEXT.notLinked;
      else if (message.voice && (!voice || !deps.voiceEnabled)) reply = TELEGRAM_TEXT.voiceRules;
      else if ((!message.text && !message.voice) || (message.text?.startsWith("/") && message.text !== "/limit")) reply = TELEGRAM_TEXT.unsupported;
      else {
        userId = employee;
        await progress("session");
        session = await within(deps.openSession(employee, deadline), remaining() - SEND_RESERVE_MS, (late) => { void late.close().catch(() => undefined); });
        if (message.text === "/limit") {
          const usage = await within(session.usage(), remaining() - SEND_RESERVE_MS);
          reply = `Вопросы сегодня: ${usage.used} из ${usage.limit}. Лимит общий с веб-чатом Nexus.`;
        } else {
          const agent = deps.agent();
          if (!agent) reply = TELEGRAM_TEXT.disabled;
          else if (remaining() - SEND_RESERVE_MS < MIN_RUN_MS) {
            // Not started: nothing reserved, nothing charged, the question is not counted.
            reply = TELEGRAM_TEXT.noTime;
            errorCode = "DEADLINE_EXCEEDED";
          } else {
            void deps.bot.call("sendChatAction", { chat_id: message.chatId, action: "typing" }, { timeoutMs: 3_000, signal: deadline }).catch(() => undefined);
            const { answer, transcript } = await askAgent(agent, session, employee, message.text, voice, deps.bot, deadline, remaining() - SEND_RESERVE_MS, progress);
            reply = shortMessage((transcript ? `Распознано: ${transcript}\n\n` : "") + answer.text);
            errorCode = answer.errorCode;
          }
        }
        // Access lost or chat relinked while the model was working: no business data leaves Nexus.
        await progress("access_check");
        const stillLinked = await within(deps.rpc("telegram_employee", { p_chat_id: message.chatId }), Math.max(remaining() - 5_000, 1_000));
        const permissions = await within(session.permissions(["agent.use"]), Math.max(remaining() - 5_000, 1_000));
        if (stillLinked !== employee || !permissions.has("agent.use")) {
          reply = TELEGRAM_TEXT.withheld;
          errorCode = "ANSWER_WITHHELD";
        }
      }
    }
  } catch {
    // Any failure before delivery, including a timeout: a fixed text without data. Nothing paid is
    // repeated; the accounting run (if any) was already closed or is settled by its TTL.
    reply = TELEGRAM_TEXT.failed;
    errorCode = "PROCESSING_ERROR";
  } finally {
    await closeSession();
  }

  if (errorCode) await progress("sending", { error: errorCode });
  // delivery_started is the point of no return: if it cannot be written, nothing is sent.
  const marked = await status("delivery_started").catch(() => false);
  if (marked !== true) {
    await status("failed").catch(() => undefined);
    return;
  }
  try {
    await deps.bot.call("sendMessage", { chat_id: message.chatId, text: reply, link_preview_options: { is_disabled: true } }, { timeoutMs: SEND_TIMEOUT_MS });
    await status("completed").catch(() => undefined);
  } catch (error) {
    // A definite refusal delivered nothing; anything else may have been delivered. Never resend.
    const definite = error instanceof TelegramError && error.code !== "TELEGRAM_UNAVAILABLE";
    await progress("sending", { error: definite ? error.code : "TELEGRAM_UNAVAILABLE" });
    await status(definite ? "failed" : "delivery_unknown").catch(() => undefined);
  }
}

async function askAgent(
  agent: TelegramAgent, session: EmployeeSession, employee: string, text: string | null, voice: ReturnType<typeof voiceInput>, bot: TelegramBot,
  deadline: AbortSignal, runMs: number, progress: (stage: Stage, extra?: { runId?: string; error?: string }) => Promise<unknown>,
): Promise<{ answer: { text: string; errorCode: string | null }; transcript: string }> {
  let transcript = "";
  const preparation = voice ? {
    reserveUsdMicros: SPEECH_RESERVE_MICROS,
    prepare: async (signal: AbortSignal) => {
      const bounded = AbortSignal.any([signal, deadline]);
      let audio: Uint8Array;
      try {
        const file = await bot.call("getFile", { file_id: voice.fileId }, { signal: bounded, timeoutMs: 8_000 }) as { file_path?: unknown; file_size?: unknown };
        if (typeof file.file_path !== "string" || Number(file.file_size) > MAX_VOICE_BYTES) throw new Error("VOICE_FILE");
        audio = await readBounded(await bot.downloadVoice(file.file_path, bounded), MAX_VOICE_BYTES);
      } catch {
        // Nothing was sent to the provider yet: no speech cost.
        throw new QuestionPreparationError("VOICE_DOWNLOAD");
      }
      const prepared = await agent.transcribe(audio, bounded);
      transcript = maskDataText(prepared.text, 1000) ?? "";
      await progress("model");
      return prepared;
    },
  } : undefined;
  const outcome = await runAgent(voice ? "Голосовой вопрос Telegram" : text, {
    channel: "telegram", userId: employee, provider: agent.provider, ledger: agent.ledger, data: session.data,
    permissions: session.permissions, pricing: agent.pricing, questionPreparation: preparation,
    // The run must end in time for the access re-check and delivery.
    limits: { ...agent.limits, runDeadlineMs: Math.max(1_000, Math.min(agent.limits.runDeadlineMs, runMs)) },
    onReserved: async (id) => { await progress(voice ? "speech" : "model", { runId: id }); },
  });
  if (outcome.ok) return { answer: { text: telegramAnswer(outcome.answer, outcome.requestsUsed, outcome.requestLimit), errorCode: null }, transcript };
  return { answer: { text: outcome.message, errorCode: /^[A-Z][A-Z_]{1,63}$/.test(outcome.code) ? outcome.code : "PROCESSING_ERROR" }, transcript };
}
