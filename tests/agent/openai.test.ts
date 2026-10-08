import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiProvider, strictSchema } from "../../src/lib/agent/providers/openai.ts";
import { ANSWER_JSON_SCHEMA } from "../../src/lib/agent/facts.ts";
import { ProviderError, type ModelRequest } from "../../src/lib/agent/types.ts";

const KEY = "sk-test-0000000000000000000000";

function request(): ModelRequest {
  return {
    messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }, { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "get_help", arguments: "{\"topic\":\"assistant\"}" }] }, { role: "tool", toolCallId: "c1", content: "{}" }],
    tools: [{ name: "get_help", description: "d", parameters: { type: "object", properties: { topic: { type: "string", maxLength: 5 } }, required: ["topic"], additionalProperties: false } }],
    answerSchema: ANSWER_JSON_SCHEMA,
    maxOutputTokens: 500,
    signal: new AbortController().signal,
  };
}

function recorder(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (response instanceof Error) throw response;
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}

describe("OpenAI provider (fake fetch, no network)", () => {
  it("sends the key only in the Authorization header, with strict tools, JSON schema and store=false", async () => {
    const { calls, fetcher } = recorder(Response.json({
      choices: [{ message: { content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "get_help", arguments: "{\"topic\":\"tasks\"}" } }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 7 },
    }));
    const provider = new OpenAiProvider({ apiKey: KEY, model: "test-model", baseUrl: "https://api.openai.com/v1" }, fetcher);
    const result = await provider.complete(request());
    assert.equal(calls[0].url, "https://api.openai.com/v1/chat/completions");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    const body = String(calls[0].init.body);
    assert.ok(!body.includes(KEY));
    const parsed = JSON.parse(body);
    assert.equal(parsed.store, false);
    assert.equal(parsed.tools[0].function.strict, true);
    assert.equal(parsed.response_format.json_schema.strict, true);
    assert.equal(parsed.messages[2].tool_calls[0].id, "c1");
    assert.equal(parsed.messages[3].tool_call_id, "c1");
    assert.ok(!body.includes("maxLength"));
    assert.deepEqual(result.toolCalls, [{ id: "t1", name: "get_help", arguments: "{\"topic\":\"tasks\"}" }]);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 7 });
  });

  it("never exposes provider error bodies and maps timeouts", async () => {
    const failing = recorder(new Response(JSON.stringify({ error: { message: `invalid key ${KEY}` } }), { status: 401 }));
    await assert.rejects(new OpenAiProvider({ apiKey: KEY, model: "m", baseUrl: "https://api.openai.com/v1" }, failing.fetcher).complete(request()),
      (error: unknown) => error instanceof ProviderError && error.code === "AGENT_PROVIDER_ERROR" && !error.message.includes(KEY));
    const controller = new AbortController();
    controller.abort();
    const aborted = recorder(new Error("aborted"));
    await assert.rejects(new OpenAiProvider({ apiKey: KEY, model: "m", baseUrl: "https://api.openai.com/v1" }, aborted.fetcher).complete({ ...request(), signal: controller.signal }),
      (error: unknown) => error instanceof ProviderError && error.code === "AGENT_TIMEOUT");
  });

  it("removes schema keywords strict mode may reject; the server still validates them", () => {
    assert.deepEqual(strictSchema({ type: "integer", minimum: 1, maximum: 20, description: "x" }), { type: "integer", description: "x" });
  });
});
