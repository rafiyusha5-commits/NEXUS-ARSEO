import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent } from "../../src/lib/agent/operations.ts";
import { fakeData, USER_ID, FakeLedger, ScriptedProvider, permissionsOf, TEST_LIMITS, TEST_PRICING } from "./fakes.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
const id = "10000000-0000-4000-8000-000000000001";
const command = {kind:"expense_allocate",params:{expense_id:id,method:"by_quantity",target_currency_id:id}};
test("allocation accepts explicit method and currency, never model amounts or payment",()=>{
 for(const method of ["by_quantity","by_weight","by_volume","by_value"])assert.ok(parseOperationIntent({...command,params:{...command.params,method}}));
 for(const patch of [{method:"manual"},{method:null},{target_currency_id:"x"},{pay:true},{lines:[]},{amount:"1"},{actor:id}])
  assert.equal(parseOperationIntent({...command,params:{...command.params,...patch}}),null);
 for(const key of Object.keys(command.params)){const p:Record<string,unknown>={...command.params};delete p[key];assert.equal(parseOperationIntent({...command,params:p}),null);}
});
test("expense allocation stays a proposal and is unavailable outside enabled web", async () => {
 for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const r = await runAgent("Создай расход", { channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(["agent.use"]), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(r.ok); assert.equal(Boolean(r.answer.operationIntent), channel === "web" && operationsEnabled); assert.deepEqual(ledger.finished[0].tools, []);
 }
});
