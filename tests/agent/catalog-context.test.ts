import assert from "node:assert/strict";
import { it } from "node:test";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { verifyAnswer } from "../../src/lib/agent/facts.ts";
import { ConversationMemory } from "../../src/lib/agent/conversation.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { FakeLedger, ScriptedProvider, fakeData, toolCall, finalAnswer, permissionsOf, ALL_PERMISSIONS, TEST_LIMITS, TEST_PRICING, USER_ID, SECRET_VALUES } from "./fakes.ts";

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

it("conversation hints expire, are masked and do not retain returned data", () => {
  const memory = new ConversationMemory();
  memory.append("user:web:tab", `Поставка, удостоверение ${SECRET_VALUES.driverDocument}`, "find_shipments", 1000);
  assert.ok(!memory.read("user:web:tab", 1001).join().includes(SECRET_VALUES.driverDocument));
  assert.deepEqual(memory.read("other:web:tab", 1001), []);
  assert.deepEqual(memory.read("user:telegram:tab", 1001), []);
  for (let i = 0; i < 8; i++) memory.append("user:web:tab", `Вопрос ${i}`, "", 1100 + i);
  assert.equal(memory.read("user:web:tab", 1200).length, 4);
  memory.clear("user:web:tab");
  assert.deepEqual(memory.read("user:web:tab", 1201), []);
  memory.append("user:web:tab", "Новый вопрос", "", 1300);
  assert.deepEqual(memory.read("user:web:tab", 30 * 60_000 + 2000), []);
});

it("follow-up receives prior search hints, but user/channel isolation and fresh tool reads remain enforced", async () => {
  const conversationKey = "catalog-context-regression";
  const base = { userId: USER_ID, channel: "web" as const, conversationKey, ledger: new FakeLedger(), data: fakeData(), permissions: permissionsOf(ALL_PERMISSIONS), limits: TEST_LIMITS, pricing: TEST_PRICING };
  const first = new ScriptedProvider([toolCall("c", "find_products", { query: "Merba" }), finalAnswer({ facts: [], commentary: [], limitations: [] })]);
  assert.equal((await runAgent("Список товаров Merba", { ...base, provider: first })).ok, true);
  const next = new ScriptedProvider([toolCall("s", "get_stock_status", { product_query: "Merba" }), finalAnswer({ facts: [{ call: "s", row: 0, fields: ["quantity_available"] }], commentary: [], limitations: [] })]);
  assert.equal((await runAgent("А сколько есть на складе?", { ...base, provider: next })).ok, true);
  assert.match(next.requests[0].messages.map(m => m.content).join(), /Список товаров Merba/);
  assert.ok(!next.requests[0].messages.map(m => m.content).join().includes("Печенье Merba"), "prior tool results are never retained");
  for (const patch of [{ userId: "other" }, { channel: "telegram" as const }, { conversationKey: "another-tab" }]) {
    const isolated = new ScriptedProvider([finalAnswer({ facts: [], commentary: [], limitations: [] })]);
    await runAgent("А сколько есть?", { ...base, ...patch, provider: isolated });
    assert.ok(!isolated.requests[0].messages.map(m => m.content).join().includes("Список товаров Merba"));
  }
});
