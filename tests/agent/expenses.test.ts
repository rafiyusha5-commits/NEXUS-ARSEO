import { test } from "node:test";
import assert from "node:assert/strict";
import { parseOperationIntent } from "../../src/lib/agent/operations.ts";
import { fakeData, USER_ID, FakeLedger, ScriptedProvider, permissionsOf, TEST_LIMITS, TEST_PRICING } from "./fakes.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
const id = "10000000-0000-4000-8000-000000000001";
const command = { kind: "expense_create", params: { shipment_id:id,expense_type:"transport",payee_counterparty_id:null,amount:"1250.50",currency_id:id,incurred_at:"2026-10-24",amount_kind:"actual",document_id:null,notes:null } };
test("expense requires explicit exact fields and preserves decimal strings", () => {
 assert.deepEqual(parseOperationIntent(command),command);
 for(const patch of [{amount:"0"},{amount:"-1"},{amount:"1.001"},{amount:1},{amount:"1e3"},{amount:"01"},{amount:"1000000000000"},{incurred_at:"2026-02-30"},{amount_kind:"yes"},{expense_type:"payment"},{notes:" "},{notes:"x".repeat(501)},{confirmed:true},{actor:id}])
  assert.equal(parseOperationIntent({...command,params:{...command.params,...patch}}),null);
 for(const key of Object.keys(command.params)){const p:Record<string,unknown>={...command.params};delete p[key];assert.equal(parseOperationIntent({...command,params:p}),null);}
});
test("all supported expense types create proposals only",()=>{
 for(const expense_type of ["goods_cost","transport","logistics","broker_fee","customs_duty","tax","stickering","marking","bank_fee","promo","return","other"])
  for(const amount_kind of ["planned","actual"])assert.ok(parseOperationIntent({...command,params:{...command.params,expense_type,amount_kind}}));
});
test("expense stays a proposal and is unavailable outside enabled web", async () => {
 for (const [channel, operationsEnabled] of [["web", true], ["web", false], ["telegram", true]] as const) {
  const ledger = new FakeLedger();
  const r = await runAgent("Создай расход", { channel, operationsEnabled, userId: USER_ID, ledger, data: fakeData(), permissions: permissionsOf(["agent.use"]), limits: TEST_LIMITS, pricing: TEST_PRICING,
   provider: new ScriptedProvider([{ content: JSON.stringify({ facts: [], commentary: [], limitations: [], operation: command }), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } }]),
  });
  assert.ok(r.ok); assert.equal(Boolean(r.answer.operationIntent), channel === "web" && operationsEnabled); assert.deepEqual(ledger.finished[0].tools, []);
 }
});
