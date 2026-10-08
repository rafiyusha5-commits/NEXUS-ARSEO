import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "../supabase/config";
import { runAgent, QuestionPreparationError } from "../agent/runner.ts";
import { loadAgentConfig } from "../agent/config.ts";
import { OpenAiProvider } from "../agent/providers/openai.ts";
import { createSupabaseAgentData } from "../agent/server/supabase-data.ts";
import { createSupabaseLedger } from "../agent/server/supabase-ledger.ts";
import { sessionPermissions } from "../agent/server/service.ts";
import { privateMessage, startCode, shortMessage } from "./protocol.ts";
import { maskDataText } from "../agent/masking.ts";
import { voiceInput, transcribeVoice, readBounded, MAX_VOICE_BYTES, SPEECH_RESERVE_MICROS } from "./speech.ts";
import { telegramAnswer } from "./format.ts";
import { TelegramClient } from "./client.ts";
import { employeeSession } from "./employee-session.ts";

async function rpc(admin: SupabaseClient, name: string, args: Record<string, unknown>): Promise<unknown> {
  const response = await admin.rpc(name, args);
  if (response.error) throw new Error("TELEGRAM_DATABASE_UNAVAILABLE");
  return response.data;
}

export async function processTelegramUpdate(update: unknown, admin: SupabaseClient, bot: TelegramClient): Promise<void> {
  const message = privateMessage(update);
  if (!message) return;
  const claim = await rpc(admin, "telegram_claim_update", { p_update_id: message.updateId, p_chat_id: message.chatId });
  if (typeof claim !== "string") return;
  const status = (value: string) => rpc(admin, "telegram_update_status", { p_update_id: message.updateId, p_token: claim, p_status: value });
  let session: Awaited<ReturnType<typeof employeeSession>> | null = null;
  let dataUserId: string | null = null;
  let reply = "";
  try {
    const code = message.text ? startCode(message.text) : null;
    if (code) {
      const linked = await rpc(admin, "telegram_request_link", { p_code: code, p_chat_id: message.chatId, p_name: message.displayName });
      reply = linked === true ? "Запрос привязки получен. Вернитесь в Nexus → Ассистент → Telegram, обновите страницу и подтвердите этот чат." : "Ссылка недействительна или истекла. Создайте новую ссылку в Nexus.";
    } else if (message.text === "/unlink") {
      await rpc(admin, "telegram_unlink_chat", { p_chat_id: message.chatId });
      reply = "Telegram отключён от Nexus.";
    } else if (message.text === "/help" || message.text === "/start") {
      reply = "Nexus ARSEO. Для доступа откройте Nexus → Ассистент → Telegram и привяжите этот личный чат. После подтверждения задавайте вопросы текстом или голосом до 60 секунд. /limit — остаток вопросов, /unlink — отключить чат. Файлы пока не поддерживаются.";
    } else {
      const employee = await rpc(admin, "telegram_employee", { p_chat_id: message.chatId });
      if (typeof employee !== "string") reply = "Этот чат не привязан или доступ отозван. Подключите Telegram в Nexus → Ассистент → Telegram.";
      else if (message.voice && (!voiceInput(message.voice) || process.env.TELEGRAM_VOICE_ENABLED !== "true" || process.env.TELEGRAM_VOICE_ACKNOWLEDGED !== "true")) reply = "Для голосового вопроса отправьте запись до 60 секунд и до 1 МБ. Если голос выключен в Nexus, напишите текстом.";
      else if ((!message.text && !message.voice) || (message.text?.startsWith("/") && message.text !== "/limit")) reply = "Задайте вопрос текстом или голосом до 60 секунд. Доступные команды: /help, /limit, /unlink. Файлы пока не поддерживаются.";
      else {
        const { url, publishableKey } = getSupabaseEnv();
        session = await employeeSession(admin, createClient(url, publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }), employee);
        dataUserId = employee;
        if (message.text === "/limit") {
          const usage = await session.client.rpc("my_agent_usage");
          const row = Array.isArray(usage.data) ? usage.data[0] : usage.data;
          if (usage.error || !row) throw new Error("TELEGRAM_DATABASE_UNAVAILABLE");
          reply = `Вопросы сегодня: ${row.requests_used} из ${row.request_limit}. Лимит общий с веб-чатом Nexus.`;
        } else {
          const config = loadAgentConfig();
          if (!config.enabled) reply = "Ассистент выключен в Nexus.";
          else {
            await bot.call("sendChatAction", { chat_id: message.chatId, action: "typing" }).catch(() => undefined);
            let transcript = "";
            const voice = voiceInput(message.voice);
            const preparation = voice ? { reserveUsdMicros: SPEECH_RESERVE_MICROS, prepare: async (signal: AbortSignal) => {
              let audio: Uint8Array;
              try {
                const file = await bot.call("getFile", { file_id: voice.fileId }) as { file_path?: unknown; file_size?: unknown };
                if (typeof file.file_path !== "string" || Number(file.file_size) > MAX_VOICE_BYTES) throw new Error("VOICE_FILE");
                audio = await readBounded(await bot.downloadVoice(file.file_path), MAX_VOICE_BYTES);
              } catch { throw new QuestionPreparationError("VOICE_DOWNLOAD"); }
              const prepared = await transcribeVoice(audio, config.apiKey, signal);
              transcript = maskDataText(prepared.text, 1000) ?? "";
              return prepared;
            } } : undefined;
            const outcome = await runAgent(voice ? "Голосовой вопрос Telegram" : message.text, {
              channel: "telegram", userId: employee,
              provider: new OpenAiProvider({ apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl, reasoningEffort: config.reasoningEffort }),
              ledger: createSupabaseLedger(admin), data: createSupabaseAgentData(session.client), permissions: sessionPermissions(session.client),
              limits: config.limits, pricing: config.pricing,
              questionPreparation: preparation,
            });
            reply = shortMessage((transcript ? `Распознано: ${transcript}\n\n` : "") + (outcome.ok ? telegramAnswer(outcome.answer, outcome.requestsUsed, outcome.requestLimit) : outcome.message));
          }
        }
      }
    }
    // Revocation/relink while the model was working must suppress the business-data reply.
    if (dataUserId && await rpc(admin, "telegram_employee", { p_chat_id: message.chatId }) !== dataUserId) reply = "Доступ отозван или привязка изменена. Ответ не отправлен.";
    if (dataUserId && session && !(await sessionPermissions(session.client)(["agent.use"])).has("agent.use")) reply = "Доступ к ассистенту отозван. Ответ не отправлен.";
    if (await status("delivery_started") !== true) return;
    await bot.call("sendMessage", { chat_id: message.chatId, text: reply, link_preview_options: { is_disabled: true } });
    await status("completed");
  } catch {
    // A delivery_started marker is never retried: Telegram has no delivery idempotency key.
    const allowed = await status("delivery_started").catch(() => false);
    if (allowed === true) await bot.call("sendMessage", { chat_id: message.chatId, text: "Не удалось обработать сообщение. Повторите вопрос или откройте Nexus." }).catch(() => undefined);
    await status("failed").catch(() => undefined);
  } finally {
    await session?.close().catch(() => undefined);
  }
}
