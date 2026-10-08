// OpenAI Chat Completions behind the provider-neutral interface. The API key is used only here on
// the server; provider error bodies are never surfaced, logged or stored. Tests inject a fetcher.
import { ProviderError, type AgentModelProvider, type ModelMessage, type ModelRequest, type ModelResponse } from "../types.ts";

/** Keywords some strict-mode schema validators reject; the server validates them itself. */
const UNSUPPORTED = new Set(["minimum", "maximum", "maxLength", "maxItems", "pattern"]);

export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !UNSUPPORTED.has(key)).map(([key, value]) => [key, strictSchema(value)]));
}

function toOpenAiMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  if (message.role === "assistant") {
    return message.toolCalls?.length
      ? { role: "assistant", content: message.content, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } })) }
      : { role: "assistant", content: message.content ?? "" };
  }
  return { role: message.role, content: message.content };
}

type OpenAiResponse = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }> } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export class OpenAiProvider implements AgentModelProvider {
  readonly name = "openai";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { apiKey: string; model: string; baseUrl: string }, fetcher: typeof fetch = fetch) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetcher = fetcher;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body = {
      model: this.model,
      messages: request.messages.map(toOpenAiMessage),
      tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: strictSchema(tool.parameters), strict: true } })),
      tool_choice: request.tools.length ? "auto" : undefined,
      response_format: { type: "json_schema", json_schema: { name: "nexus_answer", strict: true, schema: strictSchema(request.answerSchema) } },
      max_completion_tokens: request.maxOutputTokens,
      store: false,
    };
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: request.signal,
        redirect: "error",
      });
    } catch {
      throw new ProviderError(request.signal.aborted ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
    }
    if (!response.ok) throw new ProviderError(response.status === 408 || response.status === 504 ? "AGENT_TIMEOUT" : "AGENT_PROVIDER_ERROR");
    let json: OpenAiResponse;
    try {
      json = await response.json() as OpenAiResponse;
    } catch {
      throw new ProviderError("AGENT_PROVIDER_ERROR");
    }
    const usage = { inputTokens: Math.max(0, Number(json.usage?.prompt_tokens ?? 0)), outputTokens: Math.max(0, Number(json.usage?.completion_tokens ?? 0)) };
    const message = json.choices?.[0]?.message;
    if (!message) throw new ProviderError("AGENT_PROVIDER_ERROR", usage);
    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => call.type === "function" && typeof call.id === "string" && typeof call.function?.name === "string")
      .map((call) => ({ id: String(call.id).slice(0, 64), name: String(call.function!.name).slice(0, 64), arguments: String(call.function?.arguments ?? "{}") }));
    return { content: typeof message.content === "string" ? message.content : null, toolCalls, usage };
  }
}
