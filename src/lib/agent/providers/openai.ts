// Stateless Responses API. Only encrypted reasoning is retained within one run. Plaintext
// messages and tool arguments are replayed from the runtime after its masking, never from raw output.
import { ProviderError, type AgentModelProvider, type ModelMessage, type ModelRequest, type ModelResponse } from "../types.ts";
import type { ReasoningEffort } from "../config.ts";

const UNSUPPORTED = new Set(["minimum", "maximum", "maxLength", "maxItems", "pattern"]);
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !UNSUPPORTED.has(key)).map(([key, value]) => [key, strictSchema(value)]));
}

type ReasoningItem = { type: "reasoning"; id: string; summary: []; encrypted_content: string };
type ResponseBody = { status?: unknown; output?: unknown; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const counter = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

async function responseBody(response: Response): Promise<ResponseBody> {
  if (!response.body) throw new Error("EMPTY_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error("RESPONSE_TOO_LARGE"); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!record(parsed)) throw new Error("INVALID_RESPONSE");
  return parsed as ResponseBody;
}

export class OpenAiProvider implements AgentModelProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly effort?: ReasoningEffort;
  private readonly fetcher: typeof fetch;
  private readonly reasoning = new Map<number, ReasoningItem[]>();
  private context = "";
  private previousMessageCount = 0;

  constructor(options: { apiKey: string; model: string; baseUrl: string; reasoningEffort?: ReasoningEffort }, fetcher: typeof fetch = fetch) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.effort = options.reasoningEffort;
    this.fetcher = fetcher;
  }

  private input(messages: ModelMessage[]): Record<string, unknown>[] {
    const context = JSON.stringify(messages.slice(0, 2));
    if (context !== this.context || messages.length <= this.previousMessageCount) this.reasoning.clear();
    this.context = context;
    const input: Record<string, unknown>[] = [];
    messages.forEach((message, index) => {
      input.push(...(this.reasoning.get(index) ?? []));
      if (message.role === "tool") {
        input.push({ type: "function_call_output", call_id: message.toolCallId, output: message.content });
      } else if (message.role === "assistant") {
        if (message.content) input.push({ role: "assistant", content: message.content });
        for (const call of message.toolCalls ?? []) input.push({ type: "function_call", call_id: call.id, name: call.name, arguments: call.arguments });
      } else input.push({ role: message.role, content: message.content });
    });
    return input;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.model, input: this.input(request.messages), store: false,
      ...(this.effort ? { reasoning: { effort: this.effort }, include: ["reasoning.encrypted_content"] } : {}),
      tools: request.tools.map(tool => ({ type: "function", name: tool.name, description: tool.description, parameters: strictSchema(tool.parameters), strict: true })),
      ...(request.tools.length ? { tool_choice: "auto" } : {}),
      text: { format: { type: "json_schema", name: "nexus_answer", strict: true, schema: strictSchema(request.answerSchema) } },
      max_output_tokens: request.maxOutputTokens,
    };
    let response: Response;
    let json: ResponseBody;
    try {
      response = await this.fetcher(`${this.baseUrl}/responses`, {
        method: "POST", redirect: "error", signal: request.signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new ProviderError(response.status === 408 || response.status === 504 ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
      json = await responseBody(response);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(request.signal.aborted ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
    }
    // Output usage includes reasoning tokens, even when no final answer was produced.
    const usage = { inputTokens: counter(json.usage?.input_tokens), outputTokens: counter(json.usage?.output_tokens) };
    if (json.status !== "completed" || !Array.isArray(json.output)) throw new ProviderError("AGENT_PROVIDER_ERROR", usage);
    const toolCalls: ModelResponse["toolCalls"] = [];
    const texts: string[] = [];
    const reasoning: ReasoningItem[] = [];
    const ids = new Set<string>();
    for (const item of json.output) {
      if (!record(item)) throw new ProviderError("AGENT_PROVIDER_ERROR", usage);
      if (item.type === "reasoning") {
        if (typeof item.id === "string" && typeof item.encrypted_content === "string") reasoning.push({ type: "reasoning", id: item.id, summary: [], encrypted_content: item.encrypted_content });
      } else if (item.type === "function_call") {
        if (typeof item.call_id !== "string" || !/^[\w-]{1,128}$/.test(item.call_id) || ids.has(item.call_id)
          || typeof item.name !== "string" || !/^[\w-]{1,64}$/.test(item.name) || typeof item.arguments !== "string" || item.arguments.length > 8192
          || toolCalls.length >= 16) throw new ProviderError("AGENT_PROVIDER_ERROR", usage);
        ids.add(item.call_id);
        toolCalls.push({ id: item.call_id, name: item.name, arguments: item.arguments });
      } else if (item.type === "message") {
        if (!Array.isArray(item.content)) throw new ProviderError("AGENT_PROVIDER_ERROR", usage);
        for (const content of item.content) {
          if (!record(content) || content.type === "refusal") throw new ProviderError("AGENT_BAD_ANSWER", usage);
          if (content.type === "output_text" && typeof content.text === "string") texts.push(content.text);
        }
      }
    }
    const content = texts.join("") || null;
    if (!content && !toolCalls.length) throw new ProviderError("AGENT_BAD_ANSWER", usage);
    this.reasoning.set(request.messages.length, reasoning);
    this.previousMessageCount = request.messages.length;
    return { content, toolCalls, usage };
  }
}
