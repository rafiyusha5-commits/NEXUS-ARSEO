// Delivery of Nexus notifications to linked Telegram chats (202611170600). Runs in the existing bot worker.
// The text is fixed per type plus a link: the notification's own title and body never leave Nexus, so no price,
// amount, personal data or document text can reach Telegram. At most one message per notification: a send whose
// outcome is unknown is recorded as failed and never repeated.
import { notificationLink } from "../notifications/rules.ts";
import { TelegramError, type TelegramBot } from "./client.ts";

export type DeliveryItem = { id: string; type: string; entity_type: string | null; entity_id: string | null; shipment_id: string | null; stale: boolean };
export type DeliveryGroup = { user_id: string; chat_id: string; unread: number; items: DeliveryItem[] };
export type DeliveryBatch = { quiet: boolean; token: string | null; users: DeliveryGroup[] };
type Rpc = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export const TELEGRAM_NOTIFICATION_TEXT: Record<string, string> = {
  task_assigned: "Вам назначена задача",
  overdue: "Задача просрочена",
  order_blocked: "Заказ нельзя отгрузить",
  low_shelf_life: "Партия под риском по сроку годности",
  approval_request: "Нужно ваше согласование",
  price_review: "Проверьте цену в прайсе",
  cash_gap: "Проверьте платёжный календарь",
};

/** Absolute link only when the public address of Nexus is configured; otherwise the section name. */
function link(path: string, baseUrl: string | null) {
  return baseUrl ? `${baseUrl}${path}` : `Откройте Nexus: ${path}`;
}

/** One message per employee and run: one notification, a short summary, or one line for a stale backlog. */
export function composeTelegramMessage(group: DeliveryGroup, baseUrl: string | null): string {
  if (group.items.some(item => item.stale)) {
    return `В Nexus непрочитанных уведомлений: ${group.unread}.\n${link("/notifications", baseUrl)}`;
  }
  if (group.items.length === 1) {
    const item = group.items[0];
    const target = notificationLink(item);
    return `${TELEGRAM_NOTIFICATION_TEXT[item.type] ?? "Новое уведомление Nexus"}.\n${link(target?.href ?? "/notifications", baseUrl)}`;
  }
  const lines = group.items.slice(0, 5).map(item => `• ${TELEGRAM_NOTIFICATION_TEXT[item.type] ?? "Уведомление"}`);
  if (group.items.length > 5) lines.push(`• и ещё ${group.items.length - 5}`);
  return `Уведомлений Nexus: ${group.items.length}.\n${lines.join("\n")}\n${link("/notifications", baseUrl)}`;
}

/** A fetch that remembers whether the connection itself failed: then Telegram certainly did not get the message. */
export function reachabilityFetch(base: typeof fetch = fetch) {
  let unreachable = false;
  const fetcher: typeof fetch = async (input, init) => {
    unreachable = false;
    try { return await base(input, init); }
    catch (error) {
      const code = (error as { cause?: { code?: string } })?.cause?.code;
      if (code && ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH"].includes(code)) unreachable = true;
      throw error;
    }
  };
  return { fetch: fetcher, unreachable: () => unreachable };
}

/** Claims what may be sent now, sends one message per employee and records the outcome. */
export async function sendTelegramNotifications(deps: { rpc: Rpc; bot: TelegramBot; baseUrl: string | null; unreachable?: () => boolean }) {
  const batch = await deps.rpc("telegram_notification_batch", { p_limit: 50 }) as DeliveryBatch;
  const result = { quiet: batch.quiet, sent: 0, retried: 0, failed: 0 };
  if (batch.quiet || !batch.token) return result;
  for (const group of batch.users) {
    const ids = group.items.map(item => item.id);
    try {
      const message = await deps.bot.call("sendMessage", { chat_id: group.chat_id, text: composeTelegramMessage(group, deps.baseUrl), disable_web_page_preview: true }) as { message_id?: number } | null;
      await deps.rpc("telegram_notification_result", { p_token: batch.token, p_ids: ids, p_outcome: "sent", p_message_id: Number.isSafeInteger(message?.message_id) ? message!.message_id : null });
      result.sent += 1;
    } catch (error) {
      const code = error instanceof TelegramError ? error.code : "TELEGRAM_UNAVAILABLE";
      // Definitely not delivered: rate limit, refused credentials or conflict, or no connection at all -> retry later.
      // Refused by Telegram for this chat (blocked, not found) -> failed. Unknown outcome -> failed, never resent.
      const definitelyNotSent = code === "TELEGRAM_RATE_LIMIT" || code === "TELEGRAM_UNAUTHORIZED" || code === "TELEGRAM_CONFLICT"
        || (code === "TELEGRAM_UNAVAILABLE" && deps.unreachable?.() === true);
      const outcome = definitelyNotSent ? "retry" : "failed";
      const reason = code === "TELEGRAM_UNAVAILABLE" ? (definitelyNotSent ? "TELEGRAM_UNREACHABLE" : "outcome_unknown") : code === "TELEGRAM_REJECTED" ? "rejected" : code;
      await deps.rpc("telegram_notification_result", { p_token: batch.token, p_ids: ids, p_outcome: outcome, p_error: reason,
        p_retry_after: error instanceof TelegramError && error.retryAfter ? error.retryAfter : null });
      if (outcome === "retry") result.retried += 1; else result.failed += 1;
      // Telegram itself is unavailable for everybody: stop this run, the rest stays queued for the next one.
      if (code === "TELEGRAM_UNAUTHORIZED" || code === "TELEGRAM_CONFLICT" || (definitelyNotSent && code === "TELEGRAM_UNAVAILABLE")) {
        const rest = batch.users.slice(batch.users.indexOf(group) + 1).flatMap(other => other.items.map(item => item.id));
        if (rest.length) await deps.rpc("telegram_notification_result", { p_token: batch.token, p_ids: rest, p_outcome: "retry", p_error: reason });
        break;
      }
    }
  }
  return result;
}

/** The public address of Nexus for links in messages, e.g. https://nexus.example.kz; null when not configured. */
export function telegramLinkBase(value: string | undefined): string | null {
  const text = value?.trim().replace(/\/+$/, "");
  return text && /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(text) ? text : null;
}
