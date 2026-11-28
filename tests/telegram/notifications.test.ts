import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TelegramClient, TelegramError } from "../../src/lib/telegram/client.ts";
import { composeTelegramMessage, reachabilityFetch, sendTelegramNotifications, telegramLinkBase, type DeliveryBatch, type DeliveryGroup } from "../../src/lib/telegram/notifications.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const group = (items: Partial<DeliveryGroup["items"][number]>[], unread = 3): DeliveryGroup => ({
  user_id: ID, chat_id: "7001", unread,
  items: items.map((item, index) => ({ id: `d${index}`, type: "task_assigned", entity_type: "task", entity_id: ID, shipment_id: null, stale: false, ...item })),
});
/** A fake database: records every call, answers the batch from the test. */
function fakeRpc(batch: DeliveryBatch) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return { calls, rpc: async (name: string, args: Record<string, unknown>) => { calls.push({ name, args }); return name === "telegram_notification_batch" ? batch : 1; } };
}
/** A fake bot: never reaches Telegram. */
function fakeBot(answer: (payload: Record<string, unknown>) => unknown) {
  const sent: Record<string, unknown>[] = [];
  return { sent, bot: { call: async (_method: string, payload: Record<string, unknown> = {}) => { sent.push(payload); return answer(payload); }, downloadVoice: async () => new Response() } };
}

describe("Telegram notifications: text", () => {
  it("one notification: fixed text and the link to its object, nothing from the notification itself", () => {
    const text = composeTelegramMessage(group([{ type: "order_blocked", entity_type: "sale" }]), "https://nexus.example.kz");
    assert.equal(text, `Заказ нельзя отгрузить.\nhttps://nexus.example.kz/sales/${ID}?tab=shipping`);
    assert.doesNotMatch(text, /\d[\d\s]*[,.]\d{2}|KZT|EUR|₸|сумм|цен[аы]\b/i, "no amounts or prices");
  });
  it("a cash gap: the calendar link, no currency and no amount", () => {
    const text = composeTelegramMessage(group([{ type: "cash_gap", entity_type: "cash_calendar", entity_id: null }]), "https://nexus.example.kz");
    assert.equal(text, "Проверьте платёжный календарь.\nhttps://nexus.example.kz/finance/cash");
    assert.doesNotMatch(text, /\d[\d\s]*[,.]\d{2}|KZT|EUR|USD|₸|сумм/i);
  });
  it("several: one summary; a stale backlog: one line with the number of unread", () => {
    const summary = composeTelegramMessage(group(Array.from({ length: 7 }, () => ({}))), null);
    assert.match(summary, /^Уведомлений Nexus: 7\./);
    assert.match(summary, /и ещё 2/);
    assert.match(summary, /Откройте Nexus: \/notifications$/);
    assert.equal(composeTelegramMessage(group([{ stale: true }, {}], 12), null), "В Nexus непрочитанных уведомлений: 12.\nОткройте Nexus: /notifications");
  });
  it("accepts only a plain public address for links", () => {
    assert.equal(telegramLinkBase("https://nexus.example.kz/"), "https://nexus.example.kz");
    assert.equal(telegramLinkBase("javascript:alert(1)"), null);
    assert.equal(telegramLinkBase("https://nexus.example.kz/path?x=1"), null);
    assert.equal(telegramLinkBase(undefined), null);
  });
});

describe("Telegram notifications: sending", () => {
  const batch = (groups: DeliveryGroup[]): DeliveryBatch => ({ quiet: false, token: "tok", users: groups });
  it("quiet hours: nothing is sent", async () => {
    const db = fakeRpc({ quiet: true, token: null, users: [] });
    const telegram = fakeBot(() => ({ message_id: 1 }));
    assert.deepEqual(await sendTelegramNotifications({ rpc: db.rpc, bot: telegram.bot, baseUrl: null }), { quiet: true, sent: 0, retried: 0, failed: 0 });
    assert.equal(telegram.sent.length, 0);
  });
  it("one message per employee; the result names every delivery it covers", async () => {
    const db = fakeRpc(batch([group([{}, {}]), { ...group([{}]), chat_id: "7002", user_id: "u2" }]));
    const telegram = fakeBot(() => ({ message_id: 42 }));
    const result = await sendTelegramNotifications({ rpc: db.rpc, bot: telegram.bot, baseUrl: null });
    assert.equal(result.sent, 2);
    assert.deepEqual(telegram.sent.map(payload => payload.chat_id), ["7001", "7002"]);
    assert.deepEqual(db.calls[1].args, { p_token: "tok", p_ids: ["d0", "d1"], p_outcome: "sent", p_message_id: 42 });
  });
  it("unknown outcome is failed and never resent; a refusal is failed; a rate limit is retried", async () => {
    for (const [error, outcome, reason] of [
      [new TelegramError("TELEGRAM_UNAVAILABLE"), "failed", "outcome_unknown"],
      [new TelegramError("TELEGRAM_REJECTED"), "failed", "rejected"],
      [new TelegramError("TELEGRAM_RATE_LIMIT", 30), "retry", "TELEGRAM_RATE_LIMIT"],
    ] as const) {
      const db = fakeRpc(batch([group([{}])]));
      const telegram = fakeBot(() => { throw error; });
      await sendTelegramNotifications({ rpc: db.rpc, bot: telegram.bot, baseUrl: null });
      assert.equal(db.calls[1].args.p_outcome, outcome);
      assert.equal(db.calls[1].args.p_error, reason);
    }
  });
  it("Telegram unreachable: retried later, and the run stops instead of trying everyone", async () => {
    const db = fakeRpc(batch([group([{}]), { ...group([{}]), user_id: "u2", items: [{ ...group([{}]).items[0], id: "other" }] }]));
    const telegram = fakeBot(() => { throw new TelegramError("TELEGRAM_UNAVAILABLE"); });
    await sendTelegramNotifications({ rpc: db.rpc, bot: telegram.bot, baseUrl: null, unreachable: () => true });
    assert.equal(telegram.sent.length, 1, "the second chat is not tried");
    assert.deepEqual(db.calls.slice(1).map(call => [call.args.p_outcome, call.args.p_ids]), [["retry", ["d0"]], ["retry", ["other"]]]);
  });
  it("a refused connection is recognised as not delivered; no request ever leaves the test", async () => {
    const reach = reachabilityFetch(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); });
    const client = new TelegramClient("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", reach.fetch);
    await assert.rejects(client.call("sendMessage", { chat_id: 1, text: "x" }), (error: TelegramError) => error.code === "TELEGRAM_UNAVAILABLE");
    assert.equal(reach.unreachable(), true);
    const timeout = reachabilityFetch(async () => { throw new DOMException("timeout", "TimeoutError"); });
    await assert.rejects(new TelegramClient("123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ", timeout.fetch).call("sendMessage", {}));
    assert.equal(timeout.unreachable(), false, "a timeout may have delivered: not treated as unreachable");
  });
});
