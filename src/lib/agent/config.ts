// Assistant configuration. Disabled unless explicitly enabled AND the data transfer to the model
// provider is acknowledged. Without prices the money budget cannot be reserved, so it stays off.

type Env = Record<string, string | undefined>;

export type AgentLimits = {
  maxSteps: number;
  maxToolCalls: number;
  maxInputTokensTotal: number;
  maxOutputTokensTotal: number;
  maxOutputTokensPerCall: number;
  providerTimeoutMs: number;
  runDeadlineMs: number;
};

export type AgentConfig =
  | { enabled: false; reason: "DISABLED" | "NOT_ACKNOWLEDGED" | "PROVIDER_NOT_CONFIGURED" | "PRICES_NOT_CONFIGURED" | "INVALID_LIMITS" }
  | {
      enabled: true;
      provider: "openai";
      apiKey: string;
      model: string;
      baseUrl: string;
      limits: AgentLimits;
      /** USD per one million tokens; used for the conservative reservation and actual cost. */
      pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number };
    };

export const DEFAULT_LIMITS: AgentLimits = {
  maxSteps: 6,
  maxToolCalls: 8,
  maxInputTokensTotal: 60_000,
  maxOutputTokensTotal: 6_000,
  maxOutputTokensPerCall: 2_000,
  providerTimeoutMs: 30_000,
  runDeadlineMs: 55_000,
};

function bounded(raw: string | undefined, fallback: number, min: number, max: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

function price(raw: string | undefined): number | null {
  if (!raw?.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 && value < 10_000 ? value : null;
}

export function loadAgentConfig(env: Env = process.env): AgentConfig {
  if (env.AGENT_ENABLED !== "true") return { enabled: false, reason: "DISABLED" };
  if (env.AGENT_ACKNOWLEDGE_DATA_TRANSFER !== "true") return { enabled: false, reason: "NOT_ACKNOWLEDGED" };
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.AGENT_MODEL?.trim();
  if ((env.AGENT_PROVIDER ?? "openai") !== "openai" || !apiKey || !model || !/^[\w.:-]{1,80}$/.test(model)) {
    return { enabled: false, reason: "PROVIDER_NOT_CONFIGURED" };
  }
  const inputUsdPerMTok = price(env.AGENT_PRICE_INPUT_USD_PER_MTOK);
  const outputUsdPerMTok = price(env.AGENT_PRICE_OUTPUT_USD_PER_MTOK);
  if (inputUsdPerMTok === null || outputUsdPerMTok === null) return { enabled: false, reason: "PRICES_NOT_CONFIGURED" };
  const limits = {
    maxSteps: bounded(env.AGENT_MAX_STEPS, DEFAULT_LIMITS.maxSteps, 2, 10),
    maxToolCalls: bounded(env.AGENT_MAX_TOOL_CALLS, DEFAULT_LIMITS.maxToolCalls, 1, 16),
    maxInputTokensTotal: bounded(env.AGENT_MAX_INPUT_TOKENS, DEFAULT_LIMITS.maxInputTokensTotal, 4_000, 200_000),
    maxOutputTokensTotal: bounded(env.AGENT_MAX_OUTPUT_TOKENS, DEFAULT_LIMITS.maxOutputTokensTotal, 500, 20_000),
    maxOutputTokensPerCall: DEFAULT_LIMITS.maxOutputTokensPerCall,
    providerTimeoutMs: bounded(env.AGENT_PROVIDER_TIMEOUT_MS, DEFAULT_LIMITS.providerTimeoutMs, 5_000, 50_000),
    runDeadlineMs: DEFAULT_LIMITS.runDeadlineMs,
  };
  if (Object.values(limits).some((value) => value === null)) return { enabled: false, reason: "INVALID_LIMITS" };
  return {
    enabled: true,
    provider: "openai",
    apiKey,
    model,
    baseUrl: "https://api.openai.com/v1",
    limits: limits as AgentLimits,
    pricing: { inputUsdPerMTok, outputUsdPerMTok },
  };
}

/** Worst-case cost of one run in USD micros (all limits used), reserved before the first call. */
export function reserveCostMicros(limits: AgentLimits, pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number }): number {
  return Math.ceil(limits.maxInputTokensTotal * pricing.inputUsdPerMTok + limits.maxOutputTokensTotal * pricing.outputUsdPerMTok);
}

/** Actual cost in USD micros: tokens × USD per million tokens. */
export function actualCostMicros(usage: { inputTokens: number; outputTokens: number }, pricing: { inputUsdPerMTok: number; outputUsdPerMTok: number }): number {
  return Math.ceil(usage.inputTokens * pricing.inputUsdPerMTok + usage.outputTokens * pricing.outputUsdPerMTok);
}

export const DISABLED_REASON_TEXT: Record<Exclude<AgentConfig, { enabled: true }>["reason"], string> = {
  DISABLED: "Ассистент выключен. Его включает администратор: AGENT_ENABLED=true.",
  NOT_ACKNOWLEDGED: "Ассистент выключен: не подтверждена передача данных провайдеру модели (AGENT_ACKNOWLEDGE_DATA_TRANSFER).",
  PROVIDER_NOT_CONFIGURED: "Ассистент выключен: не настроен провайдер модели (AGENT_PROVIDER, AGENT_MODEL и ключ провайдера).",
  PRICES_NOT_CONFIGURED: "Ассистент выключен: не заданы цены токенов (AGENT_PRICE_INPUT_USD_PER_MTOK, AGENT_PRICE_OUTPUT_USD_PER_MTOK), без них нельзя зарезервировать бюджет.",
  INVALID_LIMITS: "Ассистент выключен: ограничения AGENT_MAX_* заданы неверно.",
};
