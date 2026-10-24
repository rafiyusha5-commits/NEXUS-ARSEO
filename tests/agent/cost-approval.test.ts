import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent } from "../../src/lib/agent/operations.ts";
import { fakeData, USER_ID, FakeLedger, ScriptedProvider, permissionsOf, TEST_LIMITS, TEST_PRICING } from "./fakes.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
const id = "10000000-0000-4000-8000-000000000001";
const command = {kind:"shipment_cost_approve",params:{calculation_id:id}};
test("cost approval accepts explicit saved version, never actor or payment",()=>{
 assert.deepEqual(parseOperationIntent(command),command);
 for(const patch of [{confirmed:true},{version:2},{calculation_id:"x"},{shipment_id:id},{pay:true},{lines:[]},{amount:"1"},{actor:id}])
  assert.equal(parseOperationIntent({...command,params:{...command.params,...patch}}),null);
 for(const key of Object.keys(command.params)){const p:Record<string,unknown>={...command.params};delete p[key];assert.equal(parseOperationIntent({...command,params:p}),null);}
});
test("cost approval stays a proposal and is unavailable outside enabled web", async () => {
 for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const r = await runAgent("Утверди себестоимость", { channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(["agent.use"]), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(r.ok); assert.equal(Boolean(r.answer.operationIntent), channel === "web" && operationsEnabled); assert.deepEqual(ledger.finished[0].tools, []);
 }
});
