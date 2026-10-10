import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { employeeSession } from "../../src/lib/telegram/employee-session.ts";
import { telegramAnswer } from "../../src/lib/telegram/format.ts";
import { telegramConfig } from "../../src/lib/telegram/config.ts";
import { channelAllowsTool } from "../../src/lib/agent/channels.ts";
const ID = "11111111-1111-4111-8111-111111111111";

function clients(options: { wrong?: boolean; denied?: boolean; mfa?: boolean } = {}) {
  let closed = false; let generated = false;
  const admin = { auth: { admin: {
    async getUserById(id: string) { assert.equal(id, ID); return { data: { user: { id, email: "employee@test.local", factors: options.mfa ? [{ status: "verified" }] : [] } } }; },
    async generateLink(input: unknown) { assert.deepEqual(input, { type: "magiclink", email: "employee@test.local" }); generated = true; return { data: { user: { id: ID }, properties: { hashed_token: "one-time" } } }; },
  } } } as unknown as SupabaseClient;
  const user = { auth: {
    async verifyOtp(input: unknown) { assert.deepEqual(input, { type: "magiclink", token_hash: "one-time" }); return { data: { user: { id: options.wrong ? "other" : ID }, session: {} } }; },
    async signOut(input: unknown) { assert.deepEqual(input, { scope: "local" }); closed = true; },
  }, async rpc(name: string, input: unknown) { assert.equal(name, "my_permissions"); assert.deepEqual(input, { p_codes: ["agent.use"] }); return { data: options.denied ? [] : ["agent.use"] }; } } as unknown as SupabaseClient;
  return { admin, user, closed: () => closed, generated: () => generated };
}
describe("Telegram employee session and reply", () => {
  it("never grants financial or newly added web tools to Telegram by default", () => {
    assert.equal(channelAllowsTool("telegram", "get_shipment"), true);
    for (const name of ["get_shipment_cost", "create_report", "new_web_tool"]) assert.equal(channelAllowsTool("telegram", name), false);
  });
  it("uses the employee session and signs out only that short-lived session", async () => {
    const value = clients(); const session = await employeeSession(value.admin, value.user, ID);
    assert.equal(session.client, value.user); assert.notEqual(session.client, value.admin);
    await session.close(); assert.equal(value.closed(), true);
  });
  it("rejects swapped identities or revoked permissions and closes any created session", async () => {
    for (const options of [{ wrong: true }, { denied: true }]) {
      const value = clients(options); await assert.rejects(employeeSession(value.admin, value.user, ID)); assert.equal(value.closed(), true);
    }
  });
  it("never bypasses a user's verified MFA", async () => {
    const value = clients({ mfa: true }); await assert.rejects(employeeSession(value.admin, value.user, ID)); assert.equal(value.generated(), false);
  });
  it("masks money, phones and identity data, labels commentary, and limits reply length", () => {
    const reply = telegramAnswer({ facts: [{ subject: "Поставка NAR-2026-0003", source: { tool: "get_shipment", row: 0 }, values: [{ label: "SKU", field: "sku_count", value: "8" }] }],
      commentary: [{ kind: "explanation", text: "045678912, ИИН 900101300123, цена 500 EUR" }], rejected: [], limitations: [], toolsUsed: [] }, 2, 20);
    assert.match(reply, /SKU: 8/); assert.match(reply, /Поставка NAR-2026-0003/, "Nexus shipment numbers stay readable in facts"); assert.match(reply, /не проверено/); assert.doesNotMatch(reply, /045678912|900101300123|500 EUR/); assert.doesNotMatch(reply, /Вопросы сегодня|2 из 20/);
    assert.ok(telegramAnswer({ facts: [], commentary: [{ kind: "assumption", text: "a".repeat(8000) }], limitations: [], rejected: [], toolsUsed: [] }, 1, 20).length <= 3900);
  });
  it("requires explicit activation, Auth acknowledgement and a server worker secret", () => {
    const config = { TELEGRAM_ENABLED: "true", TELEGRAM_AUTH_ACKNOWLEDGED: "true", TELEGRAM_BOT_TOKEN: "123456:" + "a".repeat(32), TELEGRAM_BOT_USERNAME: "nexus_bot", TELEGRAM_WORKER_SECRET: "a".repeat(64) };
    assert.ok(telegramConfig(config)); assert.equal(telegramConfig({ ...config, TELEGRAM_AUTH_ACKNOWLEDGED: "" }), null); assert.equal(telegramConfig({ ...config, TELEGRAM_WORKER_SECRET: "" }), null);
  });
});
