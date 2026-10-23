import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent, operationError, OPERATION_KINDS } from "../../src/lib/agent/operations.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { FakeLedger, ScriptedProvider, fakeData, ALL_PERMISSIONS, permissionsOf, TEST_LIMITS, TEST_PRICING, USER_ID } from "./fakes.ts";
const command = { kind: "inventory_transfer", params: {
 product_id: "10000000-0000-4000-8000-000000000001", from_warehouse_id: "10000000-0000-4000-8000-000000000002",
 to_warehouse_id: "10000000-0000-4000-8000-000000000003", quantity: "10", uom: "box",
} };
test("commands use explicit quantities, identities and units", () => {
 assert.deepEqual(parseOperationIntent(command), command);
 for (const quantity of ["0", "-1", "NaN", "1e3", "0.0001", "10 boxes", 10])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, quantity } }), null);
});
test("model cannot select SQL, RPC, Google writes or confirmation", () => {
 for (const kind of ["confirm", "execute_sql", "rpc", "drive.upload", "sheets.update", "fulfill_customer_order"])
  assert.equal(parseOperationIntent({ ...command, kind }), null);
 assert.deepEqual(OPERATION_KINDS, ["inventory_transfer"]);
 assert.equal(parseOperationIntent({ ...command, confirmed: true }), null);
 assert.equal(parseOperationIntent({ ...command, params: { ...command.params, rpc: "delete" } }), null);
});
test("ambiguous identities and unknown units fail closed", () => {
 for (const patch of [{ product_id: "Merba" }, { uom: "kg" }, { to_warehouse_id: command.params.from_warehouse_id }])
  assert.equal(parseOperationIntent({ ...command, params: { ...command.params, ...patch } }), null);
});
test("errors never forward database details or secrets", () => {
 assert.match(operationError({ message: "ASSISTANT_OPERATION_STALE" }), /изменились/);
 assert.doesNotMatch(operationError({ message: "SQL password=secret" }), /SQL|password|secret/);
});
test("model proposal alone never executes; Telegram and disabled mode discard it", async () => {
 for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const outcome = await runAgent("Подготовь перемещение двух коробов", {
   channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(ALL_PERMISSIONS), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(outcome.ok);
  assert.equal(Boolean(outcome.answer.operationIntent), channel === "web" && operationsEnabled);
  assert.deepEqual(ledger.finished[0].tools, []);
 }
});
