import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actualCostMicros, loadAgentConfig, reserveCostMicros, DEFAULT_LIMITS } from "../../src/lib/agent/config.ts";
import { parseArguments, toJsonSchema, validateParams } from "../../src/lib/agent/schema.ts";
import { AGENT_TOOLS } from "../../src/lib/agent/tools.ts";

const ENABLED = {
  AGENT_ENABLED: "true", AGENT_ACKNOWLEDGE_DATA_TRANSFER: "true", AGENT_PROVIDER: "openai", OPENAI_API_KEY: "test-key",
  AGENT_MODEL: "test-model", AGENT_PRICE_INPUT_USD_PER_MTOK: "2", AGENT_PRICE_OUTPUT_USD_PER_MTOK: "8",
  SUPABASE_SECRET_KEY: "test-server-key",
};

describe("assistant configuration", () => {
  it("is disabled by default and without the data transfer acknowledgement", () => {
    assert.deepEqual(loadAgentConfig({}), { enabled: false, reason: "DISABLED" });
    assert.deepEqual(loadAgentConfig({ ...ENABLED, AGENT_ACKNOWLEDGE_DATA_TRANSFER: undefined }), { enabled: false, reason: "NOT_ACKNOWLEDGED" });
    assert.deepEqual(loadAgentConfig({ ...ENABLED, AGENT_ENABLED: "1" }), { enabled: false, reason: "DISABLED" });
  });

  it("stays off without a provider key, a model or token prices", () => {
    assert.equal(loadAgentConfig({ ...ENABLED, OPENAI_API_KEY: "" }).enabled, false);
    assert.equal(loadAgentConfig({ ...ENABLED, AGENT_MODEL: "" }).enabled, false);
    assert.equal(loadAgentConfig({ ...ENABLED, AGENT_PROVIDER: "nvidia" }).enabled, false);
    assert.deepEqual(loadAgentConfig({ ...ENABLED, AGENT_PRICE_OUTPUT_USD_PER_MTOK: "" }), { enabled: false, reason: "PRICES_NOT_CONFIGURED" });
    assert.deepEqual(loadAgentConfig({ ...ENABLED, AGENT_MAX_STEPS: "99" }), { enabled: false, reason: "INVALID_LIMITS" });
    // Accounting RPCs are server-only, so without the server key there is no budget control.
    assert.deepEqual(loadAgentConfig({ ...ENABLED, SUPABASE_SECRET_KEY: " " }), { enabled: false, reason: "LEDGER_NOT_CONFIGURED" });
    assert.equal(loadAgentConfig({ ...ENABLED, SUPABASE_SECRET_KEY: undefined, SUPABASE_SERVICE_ROLE_KEY: "legacy" }).enabled, true);
  });

  it("enables with all settings and reserves the worst case", () => {
    const config = loadAgentConfig(ENABLED);
    assert.ok(config.enabled);
    assert.equal(reserveCostMicros(DEFAULT_LIMITS, config.pricing), DEFAULT_LIMITS.maxInputTokensTotal * 1.5 * 2 + DEFAULT_LIMITS.maxOutputTokensTotal * 8);
    assert.equal(actualCostMicros({ inputTokens: 1000, outputTokens: 100 }, config.pricing), 2800);
  });
});

describe("assistant parameter schemas", () => {
  const tool = AGENT_TOOLS.find((item) => item.name === "find_shipments")!;

  it("rejects unknown fields, wrong types and out-of-range values", () => {
    assert.deepEqual(validateParams(tool.params, { query: "NAR", sql: "drop table" }), { ok: false, error: "PARAM_UNKNOWN:sql" });
    assert.equal(validateParams(tool.params, { limit: 500 }).ok, false);
    assert.equal(validateParams(tool.params, { limit: "5" }).ok, false);
    assert.equal(validateParams(tool.params, { status: "deleted" }).ok, false);
    assert.equal(validateParams(tool.params, { query: "a,b),or(id.not.is.null" }).ok, false);
    assert.equal(validateParams(tool.params, []).ok, false);
  });

  it("accepts nulls for optional fields from strict function calling", () => {
    assert.deepEqual(validateParams(tool.params, { query: "NAR-2026", status: null, type: null, limit: 5 }), { ok: true, value: { query: "NAR-2026", limit: 5 } });
  });

  it("requires UUIDs where identifiers are expected", () => {
    const get = AGENT_TOOLS.find((item) => item.name === "get_shipment")!;
    assert.equal(validateParams(get.params, { shipment_id: "NAR-2026-0007" }).ok, false);
    assert.equal(validateParams(get.params, {}).ok, false);
  });

  it("publishes closed JSON schemas and parses arguments defensively", () => {
    for (const item of AGENT_TOOLS) {
      const schema = toJsonSchema(item.params) as { additionalProperties: boolean; required: string[]; properties: object };
      assert.equal(schema.additionalProperties, false, item.name);
      assert.deepEqual(schema.required, Object.keys(schema.properties), item.name);
    }
    assert.equal(parseArguments("{not json"), null);
    assert.equal(parseArguments("x".repeat(5000)), null);
  });

  it("offers no write, SQL or HTTP tools", () => {
    for (const item of AGENT_TOOLS) assert.doesNotMatch(item.name, /create|update|delete|approve|write|sql|http|fetch|send|upload/i);
  });
});
