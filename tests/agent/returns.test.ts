import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent } from "../../src/lib/agent/operations.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { fakeData, USER_ID, FakeLedger, ScriptedProvider, permissionsOf, TEST_LIMITS, TEST_PRICING } from "./fakes.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
const id = "10000000-0000-4000-8000-000000000001";
const row = { sale_item_id: id, batch_id: id, quantity: "2.125", reason_code: "damaged" };
const command = { kind: "customer_return_create", params: { sale_id: id, reason: "Повреждена упаковка", lines: [row] } };
test("return preserves explicit input and rejects authority/price/disposition smuggling", () => {
 assert.deepEqual(parseOperationIntent(command), command);
 for (const extra of [{ actor: id }, { unit_price: "1" }, { decision: "restock" }, { confirmed: true }]) {
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, ...extra } }), null);
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, lines: [{ ...row, ...extra }] } }), null);
 }
});
test("return rejects coercion, missing data, duplicates and oversized payloads", () => {
 for (const quantity of [null, undefined, 2, "0", "-1", "1e2", "0.0001", "NaN"])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, lines: [{ ...row, quantity }] } }), null);
 for (const lines of [[], [row, row], [{ ...row, reason_code: "unknown" }], [{ ...row, batch_id: undefined }], Array(21).fill(row)])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, lines } }), null);
 for (const reason of [null, "", " ", "x".repeat(501)])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, reason } }), null);
});
test("return read tool is bounded, permission-gated and projects no secret or price", async () => {
 const tool = TOOL_BY_NAME.get("get_return_options")!;
 assert.ok(tool.permissions.includes("sales.returns"));
 const result = await tool.run({ userId: USER_ID, signal: new AbortController().signal, data: { ...fakeData(),
  getReturnOptions: async () => Array(21).fill({ ...row, product_name: "Товар", batch_number: "LOT", shipped: 10, returned: 1, available: 9, uom: "piece", secret: "DO_NOT_LEAK", unit_price: "SECRET_PRICE" }),
 } }, { sale_id: id });
 assert.equal(result.rows.length, 20); assert.equal(result.truncated, true);
 assert.doesNotMatch(JSON.stringify(result), /DO_NOT_LEAK|SECRET_PRICE/);
});
test("return proposal is web-only and never executes from model text", async () => {
 for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const result = await runAgent("Подготовь возврат", {
   channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(["agent.use"]), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(result.ok);
  assert.equal(Boolean(result.answer.operationIntent), channel === "web" && operationsEnabled);
  assert.deepEqual(ledger.finished[0].tools, []);
 }
});
