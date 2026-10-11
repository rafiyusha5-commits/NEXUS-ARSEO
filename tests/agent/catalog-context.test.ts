import assert from "node:assert/strict";
import { it } from "node:test";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { verifyAnswer } from "../../src/lib/agent/facts.ts";
import { ConversationMemory, conversationMemory } from "../../src/lib/agent/conversation.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { FakeLedger, ScriptedProvider, fakeData, toolCall, finalAnswer, permissionsOf, ALL_PERMISSIONS, TEST_LIMITS, TEST_PRICING, USER_ID, SHIPMENT_ID, SECRET_VALUES } from "./fakes.ts";

it("catalogue lists products with zero stock and renders all 20 entries independently of model selection", async () => {
  let stockCalls = 0;
  const tool = TOOL_BY_NAME.get("find_products")!;
  const result = await tool.run({ userId: USER_ID, signal: new AbortController().signal, data: fakeData({
    async findProducts(input) {
      assert.equal(input.query, "Merba");
      return { rows: Array.from({ length: 20 }, (_, i) => ({ internal_sku: `MB-${i}`, name: { ru: `Печенье ${i}` }, brand: "Merba", unit_price: SECRET_VALUES.purchasePrice })), total: 20 };
    },
    async getStock() { stockCalls++; return { rows: [], total: 0 }; },
  }) }, { query: "Merba" });
  assert.equal(stockCalls, 0);
  assert.equal(result.truncated, false);
  assert.ok(!JSON.stringify(result).includes(SECRET_VALUES.purchasePrice));
  const answer = verifyAnswer({ facts: [], commentary: [], limitations: [] }, new Map([["catalog", { tool, result }]]));
  assert.equal(answer.facts.length, 1);
  assert.equal(answer.facts[0].values[0].value.split("\n").length, 20);
  assert.equal(answer.facts[0].link?.href, "/products?q=Merba");
});

it("catalogue pagination never claims a partial page is the whole assortment", async () => {
  const tool = TOOL_BY_NAME.get("find_products")!;
  const result = await tool.run({ userId: USER_ID, signal: new AbortController().signal, data: fakeData({ async findProducts(input) {
    assert.deepEqual(input, { query: "Merba", offset: 20, limit: 20 });
    return { rows: [{ internal_sku: "MB-21", name: { en: "Cookies" } }], total: 21 };
  } }) }, { query: "Merba", offset: 20 });
  const pages = verifyAnswer({ facts: [], commentary: [], limitations: [] }, new Map([["one", { tool, result }], ["two", { tool, result }]]));
  assert.equal(pages.facts.length, 2, "multiple pages remain in the answer");
  assert.equal(result.truncated, true);
  assert.match(String(result.rows[0].values.product_list), /^21\. MB-21/);
  assert.ok(result.notes.some(note => note.includes("полный список откройте")));
});

it("conversation references expire, are isolated and discard all extra content", () => {
  const memory = new ConversationMemory();
  const ref = { section: "shipments", id: SHIPMENT_ID, access: { all: ["shipments.view"], any: [] }, text: "Цена 247 EUR пароль: TulipRiver!" };
  memory.append("user:web:tab", [ref], 1000);
  assert.ok(!JSON.stringify(memory.read("user:web:tab", 1001)).includes("TulipRiver"));
  assert.equal(memory.read("user:web:tab", 1001)[0].id, SHIPMENT_ID);
  assert.deepEqual(memory.read("other:web:tab", 1001), []);
  assert.deepEqual(memory.read("user:telegram:tab", 1001), []);
  for (let i = 0; i < 8; i++) memory.append("user:web:tab", [{ ...ref, id: `11111111-1111-4111-8111-${String(i).padStart(12, "0")}` }], 1100 + i);
  assert.equal(memory.read("user:web:tab", 1200).length, 4);
  memory.clear("user:web:tab");
  assert.deepEqual(memory.read("user:web:tab", 1201), []);
  memory.append("user:web:tab", [ref], 1300);
  assert.deepEqual(memory.read("user:web:tab", 30 * 60_000 + 2000), []);
});

it("follow-up keeps a verified object reference, not questions or trace params", async () => {
  const conversationKey = "catalog-context-regression";
  const base = { userId: USER_ID, channel: "web" as const, conversationKey, ledger: new FakeLedger(), data: fakeData(), permissions: permissionsOf(ALL_PERMISSIONS), limits: TEST_LIMITS, pricing: TEST_PRICING };
  const first = new ScriptedProvider([toolCall("c", "find_shipments", { query: "NAR" }), finalAnswer({ facts: [], commentary: [], limitations: [] })]);
  assert.equal((await runAgent("Цена 247 EUR пароль: TulipRiver!", { ...base, provider: first })).ok, true);
  const memory = JSON.stringify(conversationMemory.read(JSON.stringify([USER_ID, "web", conversationKey])));
  assert.ok(memory.includes(SHIPMENT_ID)); assert.doesNotMatch(memory, /247|TulipRiver|NAR|params|question/);
  const next = new ScriptedProvider([toolCall("s", "get_shipment", { shipment_id: SHIPMENT_ID }), finalAnswer({ facts: [{ call: "s", row: 0, fields: ["shipment_status"] }], commentary: [], limitations: [] })]);
  assert.equal((await runAgent("А какая у неё ситуация?", { ...base, provider: next })).ok, true);
  const initial = next.requests[0].messages.map(m => m.content).join();
  assert.ok(initial.includes(SHIPMENT_ID)); assert.doesNotMatch(initial, /247 EUR|TulipRiver/);
  assert.ok(base.ledger.finished.every(run => run.tools.every(t => Object.keys(t.params).length === 0)));
  for (const patch of [{ userId: "other" }, { channel: "telegram" as const }, { conversationKey: "another-tab" }]) {
    const isolated = new ScriptedProvider([finalAnswer({ facts: [], commentary: [], limitations: [] })]);
    await runAgent("А сколько есть?", { ...base, ...patch, provider: isolated });
    assert.ok(!isolated.requests[0].messages.map(m => m.content).join().includes(SHIPMENT_ID));
  }
});

for (const revoke of ["permission", "source"] as const) it(`memory drops ${revoke}-revoked references before the next model call`, async () => {
  const conversationKey = `memory-deny-${revoke}`;
  const key = JSON.stringify([USER_ID, "web", conversationKey]);
  conversationMemory.append(key, [{ section: "drive_text", id: "Document_reference_123", version: "2026-10-11T00:00:00Z", access: { all: ["documents.drive.text.view", "prices.purchase.view"], any: [] } }]);
  let checks = 0;
  const provider = new ScriptedProvider([finalAnswer({ facts: [], commentary: [], limitations: [] })]);
  const grants = [...ALL_PERMISSIONS, "documents.drive.view", "documents.drive.text.view", "prices.purchase.view"];
  const outcome = await runAgent("Что дальше?", { channel: "web", userId: USER_ID, conversationKey, provider, ledger: new FakeLedger(),
    data: fakeData({ verifySystemAccess: async records => { checks++; assert.equal(records[0].versions?.Document_reference_123, "2026-10-11T00:00:00.000Z"); return revoke !== "source"; } }),
    permissions: permissionsOf(revoke === "permission" ? grants.filter(p => p !== "prices.purchase.view") : grants), limits: TEST_LIMITS, pricing: TEST_PRICING });
  assert.equal(outcome.ok, true); assert.ok(checks > 0); assert.ok(!provider.seen().includes("Document_reference_123"));
});
