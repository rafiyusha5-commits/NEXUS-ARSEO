// Generic HTTPS OCR service (for a self-hosted engine such as Tesseract or PaddleOCR behind your own
// endpoint). Contract, one POST per document:
//   request : { mime_type, content_base64, max_pages, language_hints }  + "Authorization: Bearer <token>"
//   response: { text, pages?, confidence?, words?: [{ text, confidence }] }
// The endpoint must be https; redirects are refused; the response is size-limited and shape-checked.

import { OcrError, type OcrInput, type OcrProvider, type OcrResult, type OcrWord } from "../types.ts";

export const HTTP_OCR_VERSION = "http-v3";
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 400_000;

type Fetch = typeof fetch;

const unit = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;

export class HttpOcrProvider implements OcrProvider {
  readonly id = "http";
  readonly version = HTTP_OCR_VERSION;
  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetcher: Fetch;

  constructor(endpoint: string, token: string, fetcher: Fetch = fetch) {
    this.endpoint = endpoint;
    this.token = token;
    this.fetcher = fetcher;
  }

  async recognize(input: OcrInput, options: { signal: AbortSignal }): Promise<OcrResult> {
    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST", redirect: "error", signal: options.signal, cache: "no-store",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ mime_type: input.mimeType, content_base64: Buffer.from(input.bytes).toString("base64"), max_pages: input.maxPages, language_hints: input.languageHints }),
      });
    } catch (error) {
      if (options.signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new OcrError("timeout", "Сервис распознавания не ответил вовремя", true);
      throw new OcrError("provider_error", "Не удалось связаться с сервисом распознавания", true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new OcrError("provider_error", response.status === 401 || response.status === 403 ? "Сервис распознавания отклонил доступ: проверьте токен" : `Сервис распознавания вернул ошибку ${response.status}`, retryable);
    }
    const raw = await response.text();
    if (raw.length > MAX_RESPONSE_BYTES) throw new OcrError("provider_error", "Ответ сервиса распознавания слишком велик");
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw) as Record<string, unknown>; } catch { throw new OcrError("provider_error", "Сервис распознавания вернул непонятный ответ", true); }
    const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT_CHARS).trim() : "";
    if (!text) throw new OcrError("empty", "На документе не найден текст: проверьте качество скана или фотографии");
    const words: OcrWord[] = Array.isArray(body.words)
      ? body.words.slice(0, 50_000).flatMap(item => {
          const word = item as { text?: unknown; confidence?: unknown };
          const confidence = unit(word.confidence);
          return typeof word.text === "string" && word.text && confidence !== null ? [{ text: word.text.slice(0, 200), confidence }] : [];
        })
      : [];
    const pages = typeof body.pages === "number" && Number.isFinite(body.pages) ? Math.min(100, Math.max(1, Math.floor(body.pages))) : 1;
    const confidence = unit(body.confidence) ?? (words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : null);
    return { text, pageCount: pages, confidence, words };
  }
}
