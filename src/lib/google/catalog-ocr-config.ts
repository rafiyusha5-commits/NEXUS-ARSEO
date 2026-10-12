import { loadOcrConfig } from "../ocr/config.ts";

/** The catalog may use only the explicitly enabled, already configured Nexus HTTP engine. */
export function catalogOcrConfig(env: Record<string, string | undefined> = process.env) {
  const config = loadOcrConfig(env);
  if (env.DRIVE_CATALOG_OCR_ENABLED !== "true") return { enabled: false as const, reason: "OCR архива выключен", config };
  if (config.provider === "disabled") return { enabled: false as const, reason: config.reason, config };
  if (config.provider !== "http") return { enabled: false as const, reason: "Для архива требуется собственный HTTP-сервис OCR Nexus", config };
  return { enabled: true as const, reason: "", config };
}
