// Google Cloud Vision (DOCUMENT_TEXT_DETECTION). Images go through images:annotate, PDFs through the
// synchronous files:annotate (at most 5 pages per request). The key travels in a header, the endpoint is
// fixed, redirects are refused and provider error bodies are never copied into messages.

import { OcrError, type OcrInput, type OcrProvider, type OcrResult, type OcrWord } from "../types.ts";

export const GOOGLE_VISION_VERSION = "vision-v1-rest-1";
const ENDPOINT = "https://vision.googleapis.com/v1";
const MAX_SYNC_PDF_PAGES = 5;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

type Fetch = typeof fetch;
type VisionPage = { confidence?: number; blocks?: Array<{ paragraphs?: Array<{ words?: Array<{ confidence?: number; symbols?: Array<{ text?: string }> }> }> }> };
type VisionResponse = { fullTextAnnotation?: { text?: string; pages?: VisionPage[] }; error?: { code?: number } };

const toBase64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function parseAnnotation(response: VisionResponse): { text: string; pages: VisionPage[] } {
  if (response.error) throw new OcrError("provider_error", "Сервис распознавания вернул ошибку", true);
  const annotation = response.fullTextAnnotation;
  return { text: annotation?.text ?? "", pages: annotation?.pages ?? [] };
}

function wordsOf(pages: VisionPage[]): OcrWord[] {
  const words: OcrWord[] = [];
  for (const page of pages) for (const block of page.blocks ?? []) for (const paragraph of block.paragraphs ?? []) for (const word of paragraph.words ?? []) {
    const text = (word.symbols ?? []).map(symbol => symbol.text ?? "").join("");
    if (text && typeof word.confidence === "number") words.push({ text, confidence: Math.min(1, Math.max(0, word.confidence)) });
  }
  return words;
}

export class GoogleVisionProvider implements OcrProvider {
  readonly id = "google_vision";
  readonly version = GOOGLE_VISION_VERSION;
  private readonly apiKey: string;
  private readonly fetcher: Fetch;

  constructor(apiKey: string, fetcher: Fetch = fetch) {
    this.apiKey = apiKey;
    this.fetcher = fetcher;
  }

  private async post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${ENDPOINT}${path}`, {
        method: "POST", redirect: "error", signal, cache: "no-store",
        headers: { "content-type": "application/json", "x-goog-api-key": this.apiKey },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw new OcrError("timeout", "Сервис распознавания не ответил вовремя", true);
      throw new OcrError("provider_error", "Не удалось связаться с сервисом распознавания", true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new OcrError("provider_error", response.status === 401 || response.status === 403 ? "Сервис распознавания отклонил доступ: проверьте настройку провайдера" : `Сервис распознавания вернул ошибку ${response.status}`, retryable);
    }
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new OcrError("provider_error", "Ответ сервиса распознавания слишком велик");
    try { return JSON.parse(text); } catch { throw new OcrError("provider_error", "Сервис распознавания вернул непонятный ответ", true); }
  }

  async recognize(input: OcrInput, options: { signal: AbortSignal }): Promise<OcrResult> {
    const features = [{ type: "DOCUMENT_TEXT_DETECTION" }];
    const imageContext = { languageHints: input.languageHints };
    if (input.kind === "pdf") {
      const pages = Array.from({ length: Math.min(input.maxPages, MAX_SYNC_PDF_PAGES) }, (_, index) => index + 1);
      const reply = await this.post("/files:annotate", {
        requests: [{ inputConfig: { mimeType: input.mimeType, content: toBase64(input.bytes) }, features, imageContext, pages }],
      }, options.signal) as { responses?: Array<{ responses?: VisionResponse[] }> };
      const parsed = (reply.responses?.[0]?.responses ?? []).map(parseAnnotation);
      const text = parsed.map(item => item.text).join("\n\n").trim();
      return this.result(text, Math.max(parsed.length, 1), parsed.flatMap(item => item.pages));
    }
    const reply = await this.post("/images:annotate", { requests: [{ image: { content: toBase64(input.bytes) }, features, imageContext }] }, options.signal) as { responses?: VisionResponse[] };
    const parsed = parseAnnotation(reply.responses?.[0] ?? {});
    return this.result(parsed.text.trim(), 1, parsed.pages);
  }

  private result(text: string, pageCount: number, pages: VisionPage[]): OcrResult {
    if (!text) throw new OcrError("empty", "На документе не найден текст: проверьте качество скана или фотографии");
    const words = wordsOf(pages);
    const confidence = words.length ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : null;
    return { text, pageCount, confidence, words };
  }
}
