import type { OcrConfig } from "../config.ts";
import type { OcrProvider } from "../types.ts";
import { GoogleVisionProvider } from "./google-vision.ts";
import { HttpOcrProvider } from "./http.ts";

/** Returns the configured provider, or null when OCR is disabled: callers must then send nothing anywhere. */
export function createOcrProvider(config: OcrConfig, fetcher: typeof fetch = fetch): OcrProvider | null {
  if (config.provider === "google_vision") return new GoogleVisionProvider(config.apiKey, fetcher);
  if (config.provider === "http") return new HttpOcrProvider(config.endpoint, config.token, fetcher);
  return null;
}
