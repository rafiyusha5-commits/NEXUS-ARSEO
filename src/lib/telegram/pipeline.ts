// One Telegram message, end to end. Pure module: every external system is injected, so failures at
// each step (session, voice download, transcription, model, Telegram) are tested with fakes.
//
// Rules:
// - An update is claimed in the database before anything paid happens; a repeated delivery, a
//   restarted or a second worker never runs the model or charges the budget again.
// - Nothing is retried automatically. When the result is unknown the state says so in Nexus.
// - Business data reaches the chat only if the employee still has access right before sending.
// - The temporary employee session is always closed (scope "local"), also after a timeout.
import { conversationMemory } from "../agent/conversation.ts";
import { DRIVE_ID, DRIVE_PERMISSIONS } from "../google/drive-readonly.ts";
import type { AgentLimits } from "../agent/config.ts";
import { maskDataText } from "../agent/masking.ts";
import { QuestionPreparationError, runAgent } from "../agent/runner.ts";
import type { AgentDataSource, AgentLedger, AgentModelProvider } from "../agent/types.ts";
import { TelegramError, type TelegramBot } from "./client.ts";
import { telegramDelivery } from "./format.ts";
import { privateMessage, shortMessage, startCode } from "./protocol.ts";
import { MAX_VOICE_BYTES, SPEECH_RESERVE_MICROS, readBounded, voiceInput } from "./speech.ts";

/**
 * Time plan of one message. One deadline covers everything from the claim to the last status write:
 * no step (RPC, session close, sendMessage) starts or waits beyond it.
 *
 *   claim … session … run (≤ deadline − sendReserve) │ access check, close │ mark → send → final status
 *                                                     └──── sendReserve ────┴──────── delivery ────────┘
 */
export type PipelineTiming = {
  /** Whole processing, below the route's maxDuration (90 s) and the worker's timeout (100 s). */
  deadlineMs: number;
  /** Kept free after the run for the access re-check, the session close and delivery. */
  sendReserveMs: number;
  /** A question is not started (and nothing reserved) with less time than this left for the run. */
  minRunMs: number;
  /** Kept free for delivery: the delivery mark, sendMessage and the final status write. */
  deliveryMs: number;
  /** Upper bound of one sendMessage. */
  sendTimeoutMs: number;
  /** sendMessage is not started with less time than this; the message is then not sent at all. */
  minSendMs: number;
  /** Kept free after sendMessage for the final status write. */
  finalWriteMs: number;
  /** Upper bound of a display-only progress write. */
  progressMs: number;
  /** Upper bound of waiting for the session close (the signOut itself continues in the background). */
  closeMs: number;
};
export const DEFAULT_TIMING: PipelineTiming = {
  deadlineMs: 75_000, sendReserveMs: 20_000, minRunMs: 20_000, deliveryMs: 12_000,
  sendTimeoutMs: 8_000, minSendMs: 2_000, finalWriteMs: 2_000, progressMs: 3_000, closeMs: 4_000,
};
export const TELEGRAM_DEADLINE_MS = DEFAULT_TIMING.deadlineMs;
export const SEND_RESERVE_MS = DEFAULT_TIMING.sendReserveMs;
export const MIN_RUN_MS = DEFAULT_TIMING.minRunMs;

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
  botUsername?: string;
  /** Service RPCs telegram_* only (server key); never business data. */
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  bot: TelegramBot;
  /** Temporary Auth session of the employee; business data is read only through it. */
  openSession: (userId: string, signal: AbortSignal) => Promise<EmployeeSession>;
  /** null when the assistant is disabled. */
  agent: () => TelegramAgent | null;
  voiceEnabled: boolean;
  /** Shortcut for timing.deadlineMs. */
  deadlineMs?: number;
  timing?: Partial<PipelineTiming>;
  now?: () => number;
};

type Stage = "session" | "speech" | "model" | "access_check" | "sending";

export const TELEGRAM_TEXT = {
  linkRequested: "Запрос привязки получен. Вернитесь в Nexus → Ассистент → Telegram, обновите страницу и подтвердите этот чат.",
  linkInvalid: "Ссылка недействительна или истекла. Создайте новую ссылку в Nexus.",
  unlinked: "Telegram отключён от Nexus.",
  help: "Nexus ARSEO. Для доступа откройте Nexus → Ассистент → Telegram и привяжите этот личный чат. После подтверждения задавайте вопросы текстом или голосом до 60 секунд. /new — новая беседа, /limit — остаток вопросов, /unlink — отключить чат. Файлы пока не поддерживаются.",
  notLinked: "Этот чат не привязан или доступ отозван. Подключите Telegram в Nexus → Ассистент → Telegram.",
  voiceRules: "Для голосового вопроса отправьте запись до 60 секунд и до 1 МБ. Если голос выключен в Nexus, напишите текстом.",
  unsupported: "Задайте вопрос текстом или голосом до 60 секунд. Доступные команды: /help, /limit, /new, /unlink. Файлы пока не поддерживаются.",
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
  const timing: PipelineTiming = { ...DEFAULT_TIMING, ...deps.timing, ...(deps.deadlineMs !== undefined ? { deadlineMs: deps.deadlineMs } : {}) };
  const now = deps.now ?? Date.now;
  // The clock starts before the claim: the deadline covers the whole chain.
  const started = now();
  const remaining = () => timing.deadlineMs - (now() - started);
  const deadline = AbortSignal.timeout(Math.max(1, timing.deadlineMs));
  /** Waits for a step only while `reserveMs` of the deadline stays free; never past the deadline. */
  const bounded = <T>(work: () => Promise<T>, reserveMs: number, capMs = Infinity, late?: (value: T) => void): Promise<T> => {
    const limit = Math.min(capMs, remaining() - reserveMs);
    if (limit <= 0) return Promise.reject(new StepTimeout());
    return within(work(), limit, late);
  };

  // A failure here throws to the caller: nothing ran, so the worker may deliver it again.
  const claim = await bounded(() => deps.rpc("telegram_claim_update", { p_update_id: message.updateId, p_chat_id: message.chatId }), timing.sendReserveMs);
  // Already claimed by an earlier delivery, a restarted or a parallel worker: never run it again.
  if (typeof claim !== "string") return;

  let userId: string | null = null;
  // Display only: a slow or lost progress write never changes what happens or delays delivery.
  const progress = (stage: Stage, extra: { runId?: string; error?: string } = {}, reserveMs = timing.sendReserveMs) => bounded(() => deps.rpc("telegram_update_progress", {
    p_update_id: message.updateId, p_token: claim, p_stage: stage, p_user_id: userId, p_run_id: extra.runId ?? null, p_error_code: extra.error ?? null,
  }), reserveMs, timing.progressMs).catch(() => false);
  const status = (value: "delivery_started" | "completed" | "failed" | "delivery_unknown", reserveMs: number) =>
    bounded(() => deps.rpc("telegram_update_status", { p_update_id: message.updateId, p_token: claim, p_status: value }), reserveMs);

  let session: EmployeeSession | null = null;
  let closed = false;
  // The signOut is always started; waiting for it is bounded so delivery keeps its time. A close that
  // outlives the wait still completes in the background (its own request timeout applies).
  const closeSession = async () => {
    if (!session || closed) return;
    closed = true;
    const closing = session.close();
    closing.catch(() => undefined);
    await bounded(() => closing, timing.deliveryMs, timing.closeMs).catch(() => undefined);
  };
  // Before delivery every step keeps the delivery window free; the access check also keeps the
  // close window free.
  const beforeDelivery = timing.deliveryMs + timing.closeMs;
  let reply: string;
  let document: string | undefined;
  let driveFile: { blob: Blob; filename: string } | undefined;
  let replyMarkup: unknown;
  let accessRequirements: { all: string[]; any: string[] }[] = [];
  let accessRecords: {section:string;ids:string[];versions?:Record<string,string>}[]=[];
  let errorCode: string | null = null;
  try {
    // File deep links also fit the link-code alphabet; never consume them as account bindings.
    const code = message.text && !/^\/start drive_/.test(message.text) ? startCode(message.text) : null;
    if (code) {
      const linked = await bounded(() => deps.rpc("telegram_request_link", { p_code: code, p_chat_id: message.chatId, p_name: message.displayName }), beforeDelivery);
      reply = linked === true ? TELEGRAM_TEXT.linkRequested : TELEGRAM_TEXT.linkInvalid;
    } else if (message.text === "/unlink") {
      await bounded(() => deps.rpc("telegram_unlink_chat", { p_chat_id: message.chatId }), beforeDelivery);
      reply = TELEGRAM_TEXT.unlinked;
    } else if (message.text === "/help" || message.text === "/start") {
      reply = TELEGRAM_TEXT.help;
    } else {
      const employee = await bounded(() => deps.rpc("telegram_employee", { p_chat_id: message.chatId }), timing.sendReserveMs);
      const voice = voiceInput(message.voice);
      if (typeof employee !== "string") reply = TELEGRAM_TEXT.notLinked;
      else if (message.voice && (!voice || !deps.voiceEnabled)) reply = TELEGRAM_TEXT.voiceRules;
      else if ((!message.text && !message.voice) || (message.text?.startsWith("/") && message.text !== "/limit" && message.text !== "/new" && !/^\/(?:start drive_|file )[A-Za-z0-9_-]{10,120}$/.test(message.text))) reply = TELEGRAM_TEXT.unsupported;
      else {
        userId = employee;
        await progress("session");
        session = await bounded(() => deps.openSession(employee, deadline), timing.sendReserveMs, Infinity, (late) => { void late.close().catch(() => undefined); });
        const requestedFile = message.text?.match(/^\/(?:start drive_|file )([A-Za-z0-9_-]{10,120})$/)?.[1];
        if (requestedFile && DRIVE_ID.test(requestedFile)) {
          accessRequirements = [{ all: [...DRIVE_PERMISSIONS], any: [] }];
          const grants = await bounded(() => session!.permissions(["agent.use", ...DRIVE_PERMISSIONS]), beforeDelivery);
          if (!["agent.use", ...DRIVE_PERMISSIONS].every(code => grants.has(code)) || !session.data.downloadDriveFile) { reply = TELEGRAM_TEXT.withheld; }
          else { driveFile = await bounded(() => session!.data.downloadDriveFile!(requestedFile, deadline), beforeDelivery); accessRecords = [{ section: "drive", ids: [requestedFile] }]; reply = driveFile.filename; }
        } else if (message.text === "/new") {
          conversationMemory.clear(JSON.stringify([employee, "telegram", String(message.chatId)]));
          reply = "Начата новая беседа. Задайте вопрос текстом или голосом.";
        } else if (message.text === "/limit") {
          const usage = await bounded(() => session!.usage(), timing.sendReserveMs);
          reply = `Вопросы сегодня: ${usage.used} из ${usage.limit}. Лимит общий с веб-чатом Nexus.`;
        } else {
          const agent = deps.agent();
          if (!agent) reply = TELEGRAM_TEXT.disabled;
          else if (remaining() - timing.sendReserveMs < timing.minRunMs) {
            // Not started: nothing reserved, nothing charged, the question is not counted.
            reply = TELEGRAM_TEXT.noTime;
            errorCode = "DEADLINE_EXCEEDED";
          } else {
            void deps.bot.call("sendChatAction", { chat_id: message.chatId, action: "typing" }, { timeoutMs: 3_000, signal: deadline }).catch(() => undefined);
            const runSession = session;
            // The run has its own deadline (remaining − sendReserve). Waiting for it, including the
            // closing ledger write, is bounded as well; a run that overruns finishes in the background.
            const { answer, transcript } = await bounded(
              () => askAgent(agent, runSession, employee, String(message.chatId), message.text, voice, deps.bot, deadline, remaining() - timing.sendReserveMs, (stage, extra) => progress(stage, extra)),
              beforeDelivery,
            );
            reply = shortMessage((transcript ? `Распознано: ${transcript}\n\n` : "") + answer.text);
            errorCode = answer.errorCode;
            document = answer.document;
            accessRequirements = answer.accessRequirements ?? [];
            accessRecords = answer.accessRecords ?? [];
            if (answer.driveFiles?.length && deps.botUsername && /^[A-Za-z0-9_]{5,32}$/.test(deps.botUsername)) replyMarkup = { inline_keyboard: answer.driveFiles.filter(file => file.id.length <= 58).map(file => [{ text: `Получить: ${file.name.slice(0, 45)}`, url: `https://t.me/${deps.botUsername}?start=drive_${file.id}` }]) };
          }
        }
        // Access lost or chat relinked while the model was working: no business data leaves Nexus.
        // A check that does not finish in time fails closed (catch below): no data is sent.
        await progress("access_check", {}, beforeDelivery);
        const stillLinked = await bounded(() => deps.rpc("telegram_employee", { p_chat_id: message.chatId }), beforeDelivery);
        const permissions = await bounded(() => session!.permissions(["agent.use", ...accessRequirements.flatMap(group => [...group.all,...group.any])]), beforeDelivery);
        const recordsVisible = !accessRecords.length || await bounded(()=>session!.data.verifySystemAccess(accessRecords,deadline),beforeDelivery);
        if (!recordsVisible || stillLinked !== employee || !permissions.has("agent.use") || accessRequirements.some(group => !group.all.every(code => permissions.has(code)) || (group.any.length && !group.any.some(code => permissions.has(code))))) {
          document = undefined;
          driveFile = undefined; replyMarkup = undefined;
          reply = TELEGRAM_TEXT.withheld;
          errorCode = "ANSWER_WITHHELD";
        }
      }
    }
  } catch {
    // Any failure before delivery, including a timeout: a fixed text without data. Nothing paid is
    // repeated; the accounting run (if any) was already closed or is settled by its TTL.
    document = undefined;
    driveFile = undefined; replyMarkup = undefined;
    reply = TELEGRAM_TEXT.failed;
    errorCode = "PROCESSING_ERROR";
  }
  // Keep the employee session alive until the final send-boundary check.
  try {
  if (errorCode) await progress("sending", { error: errorCode }, timing.deliveryMs);
  // Delivery window. Not even the delivery mark is written without time to send after it.
  if (remaining() < timing.minSendMs + timing.finalWriteMs) {
    await status("failed", 0).catch(() => undefined);
    return;
  }
  // delivery_started is the point of no return: if it cannot be written in time, nothing is sent.
  const marked = await status("delivery_started", timing.minSendMs + timing.finalWriteMs).catch(() => false);
  if (marked !== true) {
    await status("failed", 0).catch(() => undefined);
    return;
  }
  // The delivery mark and earlier progress writes may have taken seconds.
  // Recheck AFTER them. No more awaits may intervene between this check and send.
  if (session && userId && !errorCode) {
    try {
      const reserve = timing.minSendMs + timing.finalWriteMs;
      const visible = !accessRecords.length || await bounded(() => session!.data.verifySystemAccess(accessRecords, deadline), reserve);
      if (!visible) throw new Error("ANSWER_WITHHELD");
      // No separate link/permission reads: the final RPC sees one SQL snapshot.
      const authorized = await bounded(() => deps.rpc("telegram_authorize_delivery", {
        p_update_id: message.updateId, p_token: claim, p_user_id: userId,
        p_requirements: [...accessRequirements, ...(driveFile ? [{ all: [...DRIVE_PERMISSIONS], any: [] }] : [])],
      }), reserve);
      if (authorized !== true) throw new Error("ANSWER_WITHHELD");
    } catch {
      await status("failed", 0).catch(() => undefined);
      return;
    }
  }
  const sendMs = Math.min(timing.sendTimeoutMs, remaining() - timing.finalWriteMs);
  if (sendMs < timing.minSendMs) {
    // Marked but too late to send: nothing was sent, which is a definite failure.
    await status("failed", 0).catch(() => undefined);
    return;
  }
  try {
    // Exactly one delivery attempt, with the same deadline and access checks for files and text.
    await deps.bot.call(driveFile || document ? "sendDocument" : "sendMessage", driveFile
      ? { chat_id: message.chatId, caption: driveFile.filename, document: driveFile.blob, filename: driveFile.filename }
      : document
      ? { chat_id: message.chatId, caption: shortMessage(reply, 1000), document: new Blob(["\uFEFF" + document], { type: "text/plain;charset=utf-8" }) }
      : { chat_id: message.chatId, text: reply, reply_markup: replyMarkup, link_preview_options: { is_disabled: true } }, { timeoutMs: sendMs, signal: deadline });
    await status("completed", 0).catch(() => undefined);
  } catch (error) {
    // A definite refusal delivered nothing; anything else may have been delivered. Never resend.
    const definite = error instanceof TelegramError && error.code !== "TELEGRAM_UNAVAILABLE";
    await progress("sending", { error: definite ? error.code : "TELEGRAM_UNAVAILABLE" }, timing.finalWriteMs / 2);
    await status(definite ? "failed" : "delivery_unknown", 0).catch(() => undefined);
  }
  } finally { await closeSession(); }
}

async function askAgent(
  agent: TelegramAgent, session: EmployeeSession, employee: string, chatKey: string, text: string | null, voice: ReturnType<typeof voiceInput>, bot: TelegramBot,
  deadline: AbortSignal, runMs: number, progress: (stage: Stage, extra?: { runId?: string; error?: string }) => Promise<unknown>,
): Promise<{ answer: { text: string; errorCode: string | null; document?: string; driveFiles?: {id:string;name:string}[]; accessRequirements?: { all: string[]; any: string[] }[]; accessRecords?: {section:string;ids:string[];versions?:Record<string,string>}[] }; transcript: string }> {
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
    channel: "telegram", userId: employee, conversationKey: chatKey, provider: agent.provider, ledger: agent.ledger, data: session.data,
    permissions: session.permissions, pricing: agent.pricing, questionPreparation: preparation,
    // The run must end in time for the access re-check and delivery.
    limits: { ...agent.limits, runDeadlineMs: Math.max(1_000, Math.min(agent.limits.runDeadlineMs, runMs)) },
    onReserved: async (id) => { await progress(voice ? "speech" : "model", { runId: id }); },
  });
  if (outcome.ok) return { answer: { ...telegramDelivery(outcome.answer, outcome.requestsUsed, outcome.requestLimit), errorCode: null, driveFiles: outcome.answer.facts.filter(fact=>["find_drive_documents","get_drive_document"].includes(fact.source.tool)).flatMap(fact=>{ const id=fact.link?.href.match(/^\/assistant\/archive\/([A-Za-z0-9_-]{10,120})$/)?.[1]; return id ? [{id,name:fact.subject}] : []; }), accessRequirements: outcome.answer.accessRequirements, accessRecords: outcome.answer.accessRecords }, transcript };
  return { answer: { text: outcome.message, errorCode: /^[A-Z][A-Z_]{1,63}$/.test(outcome.code) ? outcome.code : "PROCESSING_ERROR" }, transcript };
}
