import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { privateMessage, startCode, shortMessage } from "../../src/lib/telegram/protocol.ts";
import { TelegramClient } from "../../src/lib/telegram/client.ts";

const message = { update_id: 1, message: { message_id: 4, chat: { id: 123, type: "private" }, from: { id: 123, is_bot: false, first_name: "Рафия" }, text: "  Поставки  " } };
describe("Telegram boundary", () => {
  it("accepts only matching human private chats, not groups, channels, edits or bot users", () => {
    assert.equal(privateMessage(message)?.text, "Поставки");
    for (const input of [null, {}, { update_id: 1, edited_message: message.message },
      { ...message, message: { ...message.message, chat: { id: 123, type: "group" } } },
      { ...message, message: { ...message.message, from: { id: 999, is_bot: false } } },
      { ...message, message: { ...message.message, from: { id: 123, is_bot: true } } },
    ]) assert.equal(privateMessage(input), null);
  });
  it("does not treat attachments as questions and validates one-time code syntax", () => {
    assert.equal(privateMessage({ ...message, message: { ...message.message, text: undefined, voice: {} } })?.text, null);
    assert.equal(startCode("/start " + "a".repeat(32)), "a".repeat(32));
    assert.equal(startCode("/start short"), null);
    assert.equal(startCode("/start " + "a".repeat(32) + " extra"), null);
  });
  it("fits Unicode answers into one Telegram message", () => {
    const value = shortMessage("🟢".repeat(5000));
    assert.ok(value.length <= 3900);
    assert.ok(!/[\ud800-\udbff]\n/.test(value));
  });
  it("never leaks bot tokens or upstream error messages", async () => {
    const token = "123456:" + "a".repeat(32);
    const fetcher = (async () => { throw new Error("secret URL /bot" + token); }) as typeof fetch;
    await assert.rejects(new TelegramClient(token, fetcher).call("getMe"), { message: "TELEGRAM_UNAVAILABLE" });
    const unauthorised = (async () => new Response("secret " + token, { status: 401 })) as typeof fetch;
    await assert.rejects(new TelegramClient(token, unauthorised).call("getMe"), { message: "TELEGRAM_UNAUTHORIZED" });
  });
  it("uses fixed Bot API methods, handles rate limits and never enables model markup", async () => {
    const fetcher = (async (_url, options) => {
      assert.equal(options?.redirect, "error");
      assert.ok(!("parse_mode" in JSON.parse(String(options?.body))));
      return Response.json({ ok: false, parameters: { retry_after: 3 } }, { status: 429 });
    }) as typeof fetch;
    await assert.rejects(new TelegramClient("123456:" + "a".repeat(32), fetcher).call("sendMessage", { chat_id: 123, text: "<b>данные</b>" }), { code: "TELEGRAM_RATE_LIMIT", retryAfter: 3 });
  });
});
