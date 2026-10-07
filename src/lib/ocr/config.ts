// OCR configuration comes only from server environment variables. Nothing is sent to a provider
// unless OCR_PROVIDER names one *and* its credentials are present; the default is "disabled".
// Values are never logged or returned; callers get booleans and ids only.

import type { OcrLimits } from "./types.ts";

export type OcrProviderId = "disabled" | "google_vision" | "http";

export type OcrConfig =
  | { provider: "disabled"; reason: string; limits: OcrLimits }
  | { provider: "google_vision"; apiKey: string; limits: OcrLimits }
  | { provider: "http"; endpoint: string; token: string; limits: OcrLimits };

type Env = Record<string, string | undefined>;

const clampInt = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  if (!value || !Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
};

export const HARD_MAX_FILE_BYTES = 4 * 1024 * 1024; // the document module's own upload cap

export function loadOcrLimits(env: Env): OcrLimits {
  return {
    maxFileBytes: clampInt(env.OCR_MAX_FILE_BYTES, HARD_MAX_FILE_BYTES, 1024, HARD_MAX_FILE_BYTES),
    maxPages: clampInt(env.OCR_MAX_PAGES, 5, 1, 10),
    maxPixels: clampInt(env.OCR_MAX_PIXELS, 40_000_000, 100_000, 100_000_000),
    timeoutMs: clampInt(env.OCR_TIMEOUT_MS, 30_000, 2_000, 120_000),
    maxDocumentsPerRun: clampInt(env.OCR_MAX_DOCUMENTS_PER_RUN, 5, 1, 20),
    maxAttempts: clampInt(env.OCR_MAX_ATTEMPTS, 3, 1, 10),
    leaseSeconds: clampInt(env.OCR_LEASE_SECONDS, 300, 30, 3600),
    runBudgetMs: clampInt(env.OCR_RUN_BUDGET_MS, 100_000, 5_000, 280_000),
  };
}

export function loadOcrConfig(env: Env = process.env): OcrConfig {
  const limits = loadOcrLimits(env);
  const requested = (env.OCR_PROVIDER ?? "").trim().toLowerCase();
  const disabled = (reason: string): OcrConfig => ({ provider: "disabled", reason, limits });

  if (!requested || requested === "disabled" || requested === "off") return disabled("OCR не включён: переменная OCR_PROVIDER не задана");
  // A second, explicit switch: choosing a provider is not enough to start sending personal documents.
  if (env.OCR_ACKNOWLEDGE_DATA_TRANSFER !== "true") return disabled("OCR не включён: не подтверждена передача документов (OCR_ACKNOWLEDGE_DATA_TRANSFER)");

  if (requested === "google_vision") {
    const apiKey = (env.OCR_GOOGLE_VISION_API_KEY ?? "").trim();
    return apiKey ? { provider: "google_vision", apiKey, limits } : disabled("OCR не включён: не задан ключ провайдера");
  }
  if (requested === "http") {
    const endpoint = (env.OCR_HTTP_ENDPOINT ?? "").trim();
    const token = (env.OCR_HTTP_TOKEN ?? "").trim();
    if (!endpoint || !token) return disabled("OCR не включён: не заданы адрес и токен сервиса распознавания");
    let url: URL;
    try { url = new URL(endpoint); } catch { return disabled("OCR не включён: некорректный адрес сервиса распознавания"); }
    if (url.protocol !== "https:") return disabled("OCR не включён: адрес сервиса распознавания должен быть https");
    if (url.username || url.password) return disabled("OCR не включён: адрес сервиса не должен содержать учётные данные");
    return { provider: "http", endpoint: url.toString(), token, limits };
  }
  return disabled(`OCR не включён: неизвестный провайдер «${requested.slice(0, 40)}»`);
}

/** What the interface may show: never keys, tokens or endpoints. */
export const describeOcrConfig = (config: OcrConfig) => config.provider === "disabled"
  ? { enabled: false as const, provider: "disabled" as const, reason: config.reason }
  : { enabled: true as const, provider: config.provider, reason: "" };
