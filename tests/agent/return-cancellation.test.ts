import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent } from "../../src/lib/agent/operations.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { fakeData, USER_ID, FakeLedger, ScriptedProvider, permissionsOf, TEST_LIMITS, TEST_PRICING } from "./fakes.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
const id = "10000000-0000-4000-8000-000000000001";
const command = { kind: "customer_return_cancel", params: { return_id: id, reason: "Возврат оформлен ошибочно" } };
test("cancellation is an exact whole-return proposal with a mandatory human reason", () => {
 assert.deepEqual(parseOperationIntent(command), command);
 for (const patch of [{ return_id: "x" }, { reason: null }, { reason: "" }, { reason: " " }, { reason: "x".repeat(501) }, { actor: id }, { quantity: 1 }, { ignore_decisions: true }, { confirmed: true }])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, ...patch } }), null);
 assert.equal(parseOperationIntent({ ...command, params: { return_id: id } }), null);
});
test("cancellation lookup projects bounded non-financial data only", async () => {
 const t = TOOL_BY_NAME.get("get_return_cancellations")!;
 const r = await t.run({ userId: USER_ID, signal: new AbortController().signal, data: fakeData({ getReturnCancellations: async () => Array(21).fill({ return_id: id, return_number: "RT-1", line_count: 2, amount: "SECRET_AMOUNT", reason: "SECRET_REASON" }) }) }, { sale_id: id });
 assert.equal(r.rows.length, 20); assert.equal(r.truncated, true);
 assert.doesNotMatch(JSON.stringify(r), /SECRET_AMOUNT|SECRET_REASON/);
 assert.ok(t.permissions.includes("sales.returns"));
});
test("cancellation stays a proposal and is unavailable outside enabled web", async () => {
 for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const r = await runAgent("Отмени возврат", { channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(["agent.use"]), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(r.ok); assert.equal(Boolean(r.answer.operationIntent), channel === "web" && operationsEnabled); assert.deepEqual(ledger.finished[0].tools, []);
 }
});

