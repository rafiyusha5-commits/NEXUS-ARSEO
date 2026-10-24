import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent } from "../../src/lib/agent/operations.ts";
import { RETURN_DECISIONS } from "../../src/lib/agent/return-decisions.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { fakeData, USER_ID, FakeLedger, ScriptedProvider, permissionsOf, TEST_LIMITS, TEST_PRICING } from "./fakes.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
const id = "10000000-0000-4000-8000-000000000001";
const command = (decision = "restock") => ({ kind: "customer_return_decide", params: { item_id: id, decision, location_id: null, note: decision === "restock" ? null : "Причина сотрудника" } });
test("return decisions preserve explicit whole-line choices, not model authority", () => {
 for (const d of Object.keys(RETURN_DECISIONS)) {
  const c = command(d); assert.deepEqual(parseOperationIntent(c), c);
  for (const extra of [{ quantity: "1" }, { actor: id }, { batch_id: id }, { confirmed: true }, { ignore_expiry: true }])
   assert.equal(parseOperationIntent({ ...c, params: { ...c.params, ...extra } }), null);
 }
});
test("return decisions require explicit nullable fields and non-restock reason, reject ignored location", () => {
 for (const patch of [{ location_id: undefined }, { note: undefined }, { note: " " }, { decision: "cancel" }, { item_id: "x" }, { note: "x".repeat(501) }])
  assert.equal(parseOperationIntent({ ...command(), params: { ...command().params, ...patch } }), null);
 for (const decision of ["write_off", "return_to_supplier"]) for (const patch of [{ note: null }, { location_id: id }])
  assert.equal(parseOperationIntent({ ...command(decision), params: { ...command(decision).params, ...patch } }), null);
});
test("decision lookup projects bounded non-financial data", async () => {
 const t = TOOL_BY_NAME.get("get_return_decisions")!;
 const r = await t.run({ userId: USER_ID, signal: new AbortController().signal, data: fakeData({ getReturnDecisions: async () => Array(21).fill({ item_id: id, warehouse_id: id, quantity: 2, uom: "piece", unit_price: "SECRET_PRICE", decision_note: "SECRET_NOTE" }) }) }, { sale_id: id });
 assert.equal(r.rows.length, 20); assert.equal(r.truncated, true);
 assert.doesNotMatch(JSON.stringify(r), /SECRET_PRICE|SECRET_NOTE/);
});
test("all three decisions remain proposals, disabled outside enabled web", async () => {
 for (const decision of Object.keys(RETURN_DECISIONS)) for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const r = await runAgent("Подготовь решение", { channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(["agent.use"]), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command(decision) }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(r.ok); assert.equal(Boolean(r.answer.operationIntent), channel === "web" && operationsEnabled); assert.deepEqual(ledger.finished[0].tools, []);
 }
});
