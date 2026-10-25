import assert from "node:assert/strict";
import { it } from "node:test";
import { requestContext } from "../../src/lib/agent/request-context.ts";
import { SYSTEM_PROMPT } from "../../src/lib/agent/prompt.ts";
import { ANSWER_JSON_SCHEMA } from "../../src/lib/agent/facts.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { SYSTEM_PERMISSIONS, SYSTEM_BY_KEY } from "../../src/lib/agent/system-registry.ts";
import { SearchInputError, validateSearchInput } from "../../src/lib/agent/search-input.ts";
import { FakeLedger, ScriptedProvider, fakeData, finalAnswer, toolCall, permissionsOf, ALL_PERMISSIONS, TEST_LIMITS, TEST_PRICING, USER_ID, SHIPMENT_ID } from "./fakes.ts";

const question = "создай реализацию товара по артикулу DEMO-001 100 штук со склада Учебный клиенту Тестовый";
const note = { facts: [], commentary: [{ kind: "explanation", text: "Уточните цену за штуку, валюту, дату отгрузки и договор либо без договора." }], limitations: [], operation: null };
const permissions = [...new Set([...ALL_PERMISSIONS, ...SYSTEM_PERMISSIONS])];
const deps = (provider: ScriptedProvider) => ({ channel: "web" as const, operationsEnabled: true, userId: USER_ID,
  provider, data: fakeData(), ledger: new FakeLedger(), permissions: permissionsOf(permissions),
  limits: { ...TEST_LIMITS, maxInputTokensTotal: 55_000 }, pricing: TEST_PRICING });

it("sales clarification fits a third model turn under the unchanged production budget", async () => {
  const provider = new ScriptedProvider([
    toolCall("p", "find_products", { query: "DEMO-001" }, { inputTokens: 15_000, outputTokens: 200 }),
    toolCall("w", "search_system", { section: "warehouses", query: "Учебный" }, { inputTokens: 15_271, outputTokens: 332 }),
    finalAnswer(note, { inputTokens: 12_000, outputTokens: 200 }),
  ]);
  const d = deps(provider);
  // A populated search page, not an empty tool response. No company records are used.
  d.data = fakeData({ async findProducts() { return {
    rows: Array.from({ length: 20 }, (_, i) => ({ internal_sku: `SYN-${i}`,
      name: { ru: "Синтетический товар для проверки объёма страницы ".repeat(3) },
      brand: "Синтетическая марка ".repeat(6) })), total: 20,
  }; } });
  const result = await runAgent(question, d);
  assert.ok(result.ok, JSON.stringify(result));
  assert.equal(provider.requests.length, 3);
  assert.equal(result.answer.operationIntent, undefined);
  assert.equal(d.ledger.finished[0].inputTokens, 42_271);
  assert.equal(d.ledger.finished[0].status, "completed");
  const first = provider.requests[0];
  const size = first.messages[0].content!.length + JSON.stringify(first.answerSchema).length;
  assert.ok(size < (SYSTEM_PROMPT.length + JSON.stringify(ANSWER_JSON_SCHEMA).length) * .7);
  assert.match(first.messages[0].content!, /задай один короткий вопрос/);
  assert.match(first.messages[0].content!, /Не подставляй 0/);
});

it("mixed operations and ambiguous follow-ups retain the complete schema; disabled channel gets null", () => {
  for (const text of ["да, подготовь", "Создай заказ и расход", "Оформи возврат продажи"]) {
    assert.deepEqual(requestContext(text, true).answerSchema.properties.operation, ANSWER_JSON_SCHEMA.properties && (ANSWER_JSON_SCHEMA.properties as Record<string, unknown>).operation);
  }
  assert.deepEqual(requestContext(question, false).answerSchema.properties.operation, { type: "null" });
  const schema = JSON.stringify(requestContext(question, true).answerSchema);
  assert.match(schema, /customer_order_create/);
  assert.match(schema, /customer_order_fulfillment/);
  assert.doesNotMatch(schema, /expense_mark_paid|shipment_transport_receive/);
});

it("invalid search filters yield repair guidance without issuing a data read", async () => {
  let reads = 0;
  const provider = new ScriptedProvider([
    toolCall("bad", "search_system", { section: "balances", query: "DEMO-001" }),
    request => {
      const last = request.messages.at(-1)!;
      assert.match(last.content!, /INVALID_PARAMS/);
      assert.match(last.content!, /убери query/);
      assert.match(last.content!, /batch_id/);
      assert.doesNotMatch(last.content!, /DEMO-001/);
      return toolCall("ok", "search_system", { section: "balances", parent_id: SHIPMENT_ID, related_by: "warehouse_id" });
    }, finalAnswer(note),
  ]);
  const d = { ...deps(provider), data: fakeData({ async readSystem() { reads++; return { rows: [], total: 0 }; } }) };
  assert.ok((await runAgent(question, d)).ok);
  assert.equal(reads, 1);
  assert.equal(d.ledger.finished[0].tools[0].error, "INVALID_PARAMS");
});

it("filter hints do not bypass permission denial", async () => {
  let reads = 0;
  const provider = new ScriptedProvider([toolCall("bad", "search_system", { section: "balances", query: "DEMO-001" }), finalAnswer(note)]);
  const d = { ...deps(provider), permissions: permissionsOf(["agent.use"]), data: fakeData({ async readSystem() { reads++; return { rows: [], total: 0 }; } }) };
  await runAgent(question, d);
  assert.equal(reads, 0);
  assert.equal(d.ledger.finished[0].tools[0].error, "PERMISSION_DENIED");
  assert.doesNotMatch(provider.requests[1].messages.at(-1)!.content!, /batch_id|warehouse_id/);
});

it("rejects unsupported filters, without silently broadening a query", () => {
  for (const [section, params] of [
    ["currencies", { status: "active" }], ["warehouses", { date: "2026-10-25" }],
    ["balances", { related_by: "product_id", parent_id: SHIPMENT_ID }],
    ["warehouses", { parent_id: SHIPMENT_ID }],
  ] as const) assert.throws(() => validateSearchInput(SYSTEM_BY_KEY.get(section)!, params), SearchInputError);
  assert.doesNotThrow(() => validateSearchInput(SYSTEM_BY_KEY.get("contracts")!, { parent_id: SHIPMENT_ID }));
});

it("the input budget remains enforced", async () => {
  const provider = new ScriptedProvider([
    toolCall("p", "find_products", { query: "DEMO-001" }, { inputTokens: 54_999, outputTokens: 50 }), finalAnswer(note),
  ]);
  const result = await runAgent(question, deps(provider));
  assert.ok(!result.ok && result.code === "AGENT_TOKEN_LIMIT");
  assert.equal(provider.requests.length, 1);
  assert.match(result.message, /внутренний лимит/);
  assert.doesNotMatch(result.message, /Уточните его/);
});
