// Telegram input is untrusted. Only a human's own private chat may enter the assistant.
export type PrivateMessage = { updateId: number; messageId: number; chatId: number; text: string | null; displayName: string; voice?: unknown };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function privateMessage(update: unknown): PrivateMessage | null {
  if (!object(update) || !Number.isSafeInteger(update.update_id) || Number(update.update_id) < 0 || !object(update.message)) return null;
  const message = update.message;
  if (!object(message.chat) || !object(message.from) || message.chat.type !== "private" || message.from.is_bot !== false
    || !positiveId(message.chat.id) || message.chat.id !== message.from.id || !positiveId(message.message_id)) return null;
  return {
    updateId: Number(update.update_id), messageId: message.message_id, chatId: message.chat.id,
    text: typeof message.text === "string" ? message.text.trim() : null,
    voice: message.voice,
    displayName: [message.from.first_name, message.from.last_name].filter((v) => typeof v === "string").join(" ").slice(0, 100),
  };
}

export function startCode(text: string): string | null {
  const match = /^\/start\s+([A-Za-z0-9_-]{32,64})$/.exec(text);
  return match?.[1] ?? null;
}

// Do not cut a surrogate pair or exceed Telegram's message limit.
export function shortMessage(text: string, max = 3900): string {
  if (text.length <= max) return text;
  const suffix = "\n\nОтвет сокращён. Уточните вопрос в Nexus.";
  let end = max - suffix.length;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end--;
  return text.slice(0, end) + suffix;
}
