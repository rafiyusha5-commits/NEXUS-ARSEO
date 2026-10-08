import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OpenAiProvider, strictSchema } from "../../src/lib/agent/providers/openai.ts";
import { ANSWER_JSON_SCHEMA } from "../../src/lib/agent/facts.ts";
import { ProviderError, type ModelRequest } from "../../src/lib/agent/types.ts";

const KEY = "sk-test-0000000000000000000000";
const OPTIONS = { apiKey: KEY, model: "gpt-5.6-terra", baseUrl: "https://api.openai.com/v1", reasoningEffort: "low" as const };
function request(): ModelRequest {
  return {
    messages: [{ role: "system", content: "s" }, { role: "user", content: "q" }],
    tools: [{ name: "get_help", description: "d", parameters: { type: "object", properties: { topic: { type: "string", maxLength: 5 } }, required: ["topic"], additionalProperties: false } }],
    answerSchema: ANSWER_JSON_SCHEMA, maxOutputTokens: 500, signal: new AbortController().signal,
  };
}
const finalOutput = { type: "message", content: [{ type: "output_text", text: '{"facts":[],"commentary":[],"limitations":[]}' }] };
function recorder(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    if (!response) throw new Error("missing fake response");
    return response;
  }) as typeof fetch;
  return { calls, fetcher };
}
const completed = (output: unknown[], usage = { input_tokens: 120, output_tokens: 7 }) => Response.json({ status: "completed", output, usage });

describe("OpenAI Responses provider (fake fetch, no network)", () => {
  it("uses Responses, strict tools and answer schema, with no stored response or key in the body", async () => {
    const { calls, fetcher } = recorder(completed([{ type: "function_call", call_id: "call_1", name: "get_help", arguments: '{"topic":"tasks"}' }]));
    const result = await new OpenAiProvider(OPTIONS, fetcher).complete(request());
    assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
    assert.equal((calls[0].init.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].init.redirect, "error");
    const body = String(calls[0].init.body);
    const parsed = JSON.parse(body);
    assert.ok(!body.includes(KEY));
    assert.equal(parsed.store, false);
    assert.equal(parsed.tools[0].strict, true);
    assert.equal(parsed.text.format.strict, true);
    assert.equal(parsed.max_output_tokens, 500);
    assert.deepEqual(parsed.reasoning, { effort: "low" });
    assert.deepEqual(parsed.include, ["reasoning.encrypted_content"]);
    assert.ok(!body.includes("maxLength"));
    assert.deepEqual(result.toolCalls, [{ id: "call_1", name: "get_help", arguments: '{"topic":"tasks"}' }]);
    assert.deepEqual(result.usage, { inputTokens: 120, outputTokens: 7 });
  });

  it("replays only encrypted reasoning and the runtime's masked arguments and text, including parallel tool outputs", async () => {
    const secret = "045678912";
    const { calls, fetcher } = recorder(completed([
      { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [{ text: secret }] },
      { type: "message", content: [{ type: "output_text", text: secret }] },
      { type: "function_call", call_id: "call_1", name: "get_help", arguments: JSON.stringify({ topic: secret }) },
      { type: "function_call", call_id: "call_2", name: "get_help", arguments: '{"topic":"documents"}' },
    ]), completed([finalOutput]));
    const provider = new OpenAiProvider(OPTIONS, fetcher);
    const first = request();
    await provider.complete(first);
    const result = await provider.complete({ ...first, messages: [...first.messages,
      { role: "assistant", content: "[скрыто]", toolCalls: [{ id: "call_1", name: "get_help", arguments: '{"topic":"[скрыто]"}' }, { id: "call_2", name: "get_help", arguments: '{"topic":"documents"}' }] },
      { role: "tool", toolCallId: "call_1", content: "{}" }, { role: "tool", toolCallId: "call_2", content: "{}" },
    ] });
    const body = String(calls[1].init.body);
    assert.ok(!body.includes(secret));
    const input = JSON.parse(body).input;
    assert.deepEqual(input[2], { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] });
    assert.equal(input.filter((i: { type: string }) => i.type === "function_call_output").length, 2);
    assert.ok(result.content?.includes('"facts"'));
  });

  it("does not carry reasoning to another question or a restarted conversation", async () => {
    const { calls, fetcher } = recorder(completed([{ type: "reasoning", id: "rs_old", encrypted_content: "old-secret-context" }, finalOutput]), completed([finalOutput]));
    const provider = new OpenAiProvider(OPTIONS, fetcher);
    await provider.complete(request());
    await provider.complete({ ...request(), messages: [{ role: "system", content: "s" }, { role: "user", content: "other question" }] });
    assert.ok(!String(calls[1].init.body).includes("old-secret-context"));
  });

  it("reports billed usage on incomplete output and refusal, including reasoning tokens", async () => {
    for (const response of [Response.json({ status: "incomplete", output: [], usage: { input_tokens: 300, output_tokens: 500 } }),
      completed([{ type: "message", content: [{ type: "refusal", refusal: KEY }] }], { input_tokens: 300, output_tokens: 500 })]) {
      const { fetcher } = recorder(response);
      await assert.rejects(new OpenAiProvider(OPTIONS, fetcher).complete(request()), (error: unknown) =>
        error instanceof ProviderError && error.usage.inputTokens === 300 && error.usage.outputTokens === 500 && !error.message.includes(KEY));
    }
  });

  it("keeps network, HTTP, stream and JSON failures safe and maps timeouts", async () => {
    for (const response of [new Error(KEY), new Response(JSON.stringify({ error: { message: KEY } }), { status: 401 }),
      new Response("broken json"), new Response(new ReadableStream({ start(controller) { controller.error(new Error(KEY)); } }))]) {
      const { fetcher } = recorder(response);
      await assert.rejects(new OpenAiProvider(OPTIONS, fetcher).complete(request()), (error: unknown) =>
        error instanceof ProviderError && error.code === "AGENT_PROVIDER_ERROR" && !error.message.includes(KEY));
    }
    const controller = new AbortController(); controller.abort();
    const { fetcher } = recorder(new Error("aborted"));
    await assert.rejects(new OpenAiProvider(OPTIONS, fetcher).complete({ ...request(), signal: controller.signal }),
      (error: unknown) => error instanceof ProviderError && error.code === "AGENT_TIMEOUT");
  });

  it("rejects oversized responses, malformed output and duplicate tool call ids", async () => {
    for (const response of [new Response("x".repeat(2 * 1024 * 1024 + 1)), completed([]), completed([null]),
      completed([{ type: "function_call", call_id: "c", name: "get_help", arguments: "{}" }, { type: "function_call", call_id: "c", name: "get_help", arguments: "{}" }])]) {
      const { fetcher } = recorder(response);
      await assert.rejects(new OpenAiProvider(OPTIONS, fetcher).complete(request()), ProviderError);
    }
  });

  it("supports models without reasoning and does not generate invalid usage counters", async () => {
    const { calls, fetcher } = recorder(Response.json({ status: "completed", output: [finalOutput], usage: { input_tokens: "invalid", output_tokens: -1 } }));
    const result = await new OpenAiProvider({ apiKey: KEY, model: "gpt-4.1-mini", baseUrl: OPTIONS.baseUrl }, fetcher).complete(request());
    assert.ok(!("reasoning" in JSON.parse(String(calls[0].init.body))));
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0 });
  });

  it("removes unsupported schema keywords while keeping server validation", () => {
    assert.deepEqual(strictSchema({ type: "integer", minimum: 1, maximum: 20, description: "x" }), { type: "integer", description: "x" });
  });
});
