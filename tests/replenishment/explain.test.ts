import { it } from "node:test";
import assert from "node:assert/strict";
import { explainCalculation } from "../../src/lib/replenishment/explain.ts";
import { calculate } from "../../src/lib/replenishment/calculate.ts";
import { fixture } from "./fixture.ts";
import { ProviderError, type AgentLedger, type AgentModelProvider, type FinishInput } from "../../src/lib/agent/types.ts";
import { loadAgentConfig } from "../../src/lib/agent/config.ts";
const config = loadAgentConfig({ AGENT_ENABLED: "true", AGENT_ACKNOWLEDGE_DATA_TRANSFER: "true", OPENAI_API_KEY: "synthetic", AGENT_MODEL: "test-model", AGENT_PRICE_INPUT_USD_PER_MTOK: "1", AGENT_PRICE_OUTPUT_USD_PER_MTOK: "2", SUPABASE_SECRET_KEY: "synthetic" });
function mock() {
  const finishes: FinishInput[] = []; let reserved = 0;
  const ledger: AgentLedger = { async reserve() { reserved++; return { userId: "U", runId: "R", finishToken: "synthetic", requestLimit: 10, requestsUsed: 1 }; }, async finish(_, input) { finishes.push(input); } };
  const provider: AgentModelProvider = { name: "test", model: "test", async complete(request) { assert.equal(request.tools.length, 0); assert.ok(!JSON.stringify(request).includes("SECRET_REASON")); return { content: '{"explanation":"В Астане спрос выше, чем в Алматы. Сначала проверьте доступный запас."}', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 } }; } };
  return { ledger, provider, finishes, get reserved() { return reserved; } };
}
it("model explanation uses accounting and cannot change calculated facts", async () => {
  assert.ok(config.enabled); const f = fixture(); f.settings.overrides[0].reason = "SECRET_REASON"; const r = calculate(f), before = structuredClone(r), m = mock();
  assert.match(await explainCalculation(r, "U", config, m.provider, m.ledger), /Астане/);
  assert.deepEqual(r, before); assert.equal(m.reserved, 1); assert.equal(m.finishes[0].status, "completed"); assert.equal(m.finishes[0].actualUsdMicros, 140);
});
it("invented numeric output is rejected and billed, not shown as fact", async () => {
  assert.ok(config.enabled); const m = mock(); m.provider.complete = async () => ({ content: '{"explanation":"Купите 999999 штук"}', toolCalls: [], usage: { inputTokens: 100, outputTokens: 20 } });
  await assert.rejects(explainCalculation(calculate(fixture()), "U", config, m.provider, m.ledger)); assert.equal(m.finishes[0].status, "failed");
});
it("timeouts and absent usage do not silently become free requests", async () => {
  assert.ok(config.enabled); const m = mock(); m.provider.complete = async () => { throw new ProviderError("TIMEOUT", undefined, false); };
  await assert.rejects(explainCalculation(calculate(fixture()), "U", config, m.provider, m.ledger)); assert.ok(m.finishes[0].actualUsdMicros > 0); assert.equal(m.finishes[0].refund, false);
});
it("budget denial prevents provider calls", async () => {
  assert.ok(config.enabled); const m = mock(); m.ledger.reserve = async () => { throw new Error("AGENT_DAILY_LIMIT"); }; let called = false;
  m.provider.complete = async () => { called = true; throw new Error(); };
  await assert.rejects(explainCalculation(calculate(fixture()), "U", config, m.provider, m.ledger)); assert.equal(called, false); assert.equal(m.finishes.length, 0);
});
