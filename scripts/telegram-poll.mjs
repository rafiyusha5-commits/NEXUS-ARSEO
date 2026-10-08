// Local pilot: no public tunnel, webhook, or plaintext questions in logs/files.
import fs from "node:fs";
import { TelegramClient, TelegramError } from "../src/lib/telegram/client.ts";
function envFile(path) {
  if (!fs.existsSync(path)) return {};
  return Object.fromEntries(fs.readFileSync(path, "utf8").split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line)).map(line => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1).trim().replace(/^(["'])(.*)\1$/, "$2")];
  }));
}
const vars = { ...envFile(".env.local"), ...envFile(".env.telegram.local") };
if (vars.TELEGRAM_ENABLED !== "true" || !/^[a-f0-9]{64}$/.test(vars.TELEGRAM_WORKER_SECRET ?? "")) throw new Error("TELEGRAM_NOT_CONFIGURED");
const bot = new TelegramClient(vars.TELEGRAM_BOT_TOKEN ?? "");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { stopping = true; });
const webhook = await bot.call("getWebhookInfo");
if (webhook?.url) throw new Error("TELEGRAM_WEBHOOK_PRESENT");
console.log("Telegram local worker started");
let offset = 0;
while (!stopping) {
  try {
    const updates = await bot.call("getUpdates", { offset, timeout: 25, limit: 10, allowed_updates: ["message"] });
    if (!Array.isArray(updates)) throw new Error("TELEGRAM_INVALID_UPDATES");
    for (const update of updates) {
      if (!Number.isSafeInteger(update?.update_id)) throw new Error("TELEGRAM_INVALID_UPDATES");
      const source = update.message;
      const input = { update_id: update.update_id, message: source ? {
        message_id: source.message_id, chat: { id: source.chat?.id, type: source.chat?.type },
        from: { id: source.from?.id, is_bot: source.from?.is_bot, first_name: source.from?.first_name, last_name: source.from?.last_name },
        text: typeof source.text === "string" ? source.text : null,
        voice: source.voice ? { file_id: source.voice.file_id, duration: source.voice.duration, file_size: source.voice.file_size } : undefined,
      } : undefined };
      const response = await fetch("http://127.0.0.1:3000/api/telegram/process", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(90000),
        headers: { "Content-Type": "application/json", "x-nexus-telegram-worker": vars.TELEGRAM_WORKER_SECRET },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("NEXUS_WORKER_UNAVAILABLE");
      offset = update.update_id + 1;
    }
  } catch (error) {
    console.error(error instanceof TelegramError ? error.code : "NEXUS_WORKER_UNAVAILABLE");
    if (error instanceof TelegramError && ["TELEGRAM_CONFLICT", "TELEGRAM_UNAUTHORIZED"].includes(error.code)) break;
    await delay(error instanceof TelegramError && error.retryAfter ? error.retryAfter * 1000 : 5000);
  }
}
