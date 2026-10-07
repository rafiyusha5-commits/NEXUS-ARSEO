import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GoogleVisionProvider } from "../../src/lib/ocr/providers/google-vision.ts";
import { HttpOcrProvider } from "../../src/lib/ocr/providers/http.ts";
import { createOcrProvider } from "../../src/lib/ocr/providers/index.ts";
import { loadOcrConfig } from "../../src/lib/ocr/config.ts";
import { OcrError, type OcrInput } from "../../src/lib/ocr/types.ts";
import { pngBytes } from "./helpers.ts";

const SECRET = "very-secret-key-123";
const input = (overrides: Partial<OcrInput> = {}): OcrInput => ({ bytes: pngBytes(800, 600), kind: "png", mimeType: "image/png", maxPages: 5, languageHints: ["ru", "en"], ...overrides });
const signal = () => new AbortController().signal;
const reply = (body: unknown, status = 200) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

type Seen = { url: string; init: RequestInit };
const recording = (answer: () => Promise<Response>) => {
  const seen: Seen[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), init: init ?? {} }); return answer(); }) as typeof fetch;
  return { seen, fetcher };
};
const visionWord = (text: string, confidence: number) => ({ confidence, symbols: [...text].map(character => ({ text: character })) });
const visionBody = { responses: [{ fullTextAnnotation: { text: "Госномер: 754BA04", pages: [{ blocks: [{ paragraphs: [{ words: [visionWord("Госномер:", 0.99), visionWord("754BA04", 0.62)] }] }] }] } }] };

const rejection = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as OcrError; }
  throw new Error("expected a rejection");
};

describe("Google Vision provider", () => {
  it("calls only the fixed endpoint with the key in a header and never follows redirects", async () => {
    const { seen, fetcher } = recording(reply(visionBody));
    const result = await new GoogleVisionProvider(SECRET, fetcher).recognize(input(), { signal: signal() });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://vision.googleapis.com/v1/images:annotate");
    assert.equal(seen[0].url.includes(SECRET), false, "the key must not travel in the URL");
    assert.equal((seen[0].init.headers as Record<string, string>)["x-goog-api-key"], SECRET);
    assert.equal(seen[0].init.redirect, "error");
    const body = JSON.parse(String(seen[0].init.body));
    assert.equal(body.requests[0].features[0].type, "DOCUMENT_TEXT_DETECTION");
    assert.deepEqual(body.requests[0].imageContext.languageHints, ["ru", "en"]);
    assert.equal(result.text, "Госномер: 754BA04");
    assert.deepEqual(result.words.map(word => word.text), ["Госномер:", "754BA04"]);
    assert.ok(Math.abs((result.confidence ?? 0) - 0.805) < 1e-9, "mean word confidence");
  });

  it("sends PDFs to files:annotate with at most five pages", async () => {
    const { seen, fetcher } = recording(reply({ responses: [{ responses: [visionBody.responses[0], visionBody.responses[0]] }] }));
    const result = await new GoogleVisionProvider(SECRET, fetcher).recognize(input({ kind: "pdf", mimeType: "application/pdf", maxPages: 9 }), { signal: signal() });
    assert.equal(seen[0].url, "https://vision.googleapis.com/v1/files:annotate");
    assert.deepEqual(JSON.parse(String(seen[0].init.body)).requests[0].pages, [1, 2, 3, 4, 5]);
    assert.equal(result.pageCount, 2);
  });

  it("turns failures into safe messages without leaking the key or the provider body", async () => {
    const leaky = JSON.stringify({ error: { message: `bad key ${SECRET}`, details: "internal stack" } });
    const denied = await rejection(new GoogleVisionProvider(SECRET, recording(reply(leaky, 403)).fetcher).recognize(input(), { signal: signal() }));
    assert.equal(denied.code, "provider_error");
    assert.equal(denied.retryable, false);
    assert.equal(denied.message.includes(SECRET) || denied.message.includes("internal stack"), false);
    const busy = await rejection(new GoogleVisionProvider(SECRET, recording(reply("x", 503)).fetcher).recognize(input(), { signal: signal() }));
    assert.equal(busy.retryable, true);
    const network = await rejection(new GoogleVisionProvider(SECRET, (async () => { throw new Error(`ECONNRESET to host with ${SECRET}`); }) as typeof fetch).recognize(input(), { signal: signal() }));
    assert.equal(network.code, "provider_error");
    assert.equal(network.message.includes(SECRET), false);
  });

  it("reports a timeout when the request is aborted, and an empty page as 'empty'", async () => {
    const controller = new AbortController();
    const never = (async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as typeof fetch;
    const pending = rejection(new GoogleVisionProvider(SECRET, never).recognize(input(), { signal: controller.signal }));
    controller.abort();
    assert.equal((await pending).code, "timeout");
    const empty = await rejection(new GoogleVisionProvider(SECRET, recording(reply({ responses: [{}] })).fetcher).recognize(input(), { signal: signal() }));
    assert.equal(empty.code, "empty");
    const garbage = await rejection(new GoogleVisionProvider(SECRET, recording(reply("<html>")).fetcher).recognize(input(), { signal: signal() }));
    assert.equal(garbage.code, "provider_error");
  });
});

describe("HTTP OCR provider", () => {
  const endpoint = "https://ocr.internal.example/v1/recognize";

  it("posts the document with a bearer token and reads the documented response", async () => {
    const { seen, fetcher } = recording(reply({ text: "Водитель: Иванов И.И.", pages: 2, words: [{ text: "Иванов", confidence: 0.9 }, { text: "bad", confidence: "x" }, { text: "", confidence: 1 }, { text: "И.И.", confidence: 7 }] }));
    const result = await new HttpOcrProvider(endpoint, SECRET, fetcher).recognize(input(), { signal: signal() });
    assert.equal(seen[0].url, endpoint);
    assert.equal((seen[0].init.headers as Record<string, string>).authorization, `Bearer ${SECRET}`);
    assert.equal(seen[0].init.redirect, "error");
    const body = JSON.parse(String(seen[0].init.body));
    assert.equal(body.mime_type, "image/png");
    assert.equal(typeof body.content_base64, "string");
    assert.equal(result.pageCount, 2);
    assert.deepEqual(result.words, [{ text: "Иванов", confidence: 0.9 }, { text: "И.И.", confidence: 1 }], "malformed words dropped, confidence clamped");
  });

  it("rejects unusable answers and keeps secrets out of errors", async () => {
    for (const [answer, code] of [[reply("not json"), "provider_error"], [reply({ text: "   " }), "empty"], [reply({}, 500), "provider_error"]] as const) {
      const error = await rejection(new HttpOcrProvider(endpoint, SECRET, recording(answer).fetcher).recognize(input(), { signal: signal() }));
      assert.equal(error.code, code);
      assert.equal(error.message.includes(SECRET) || error.message.includes("ocr.internal"), false);
    }
    const throttled = await rejection(new HttpOcrProvider(endpoint, SECRET, recording(reply("slow down", 429)).fetcher).recognize(input(), { signal: signal() }));
    assert.equal(throttled.retryable, true);
  });
});

describe("provider factory", () => {
  it("returns no provider when OCR is disabled, so nothing can be sent", () => {
    assert.equal(createOcrProvider(loadOcrConfig({})), null);
    const provider = createOcrProvider(loadOcrConfig({ OCR_PROVIDER: "google_vision", OCR_ACKNOWLEDGE_DATA_TRANSFER: "true", OCR_GOOGLE_VISION_API_KEY: "k" }));
    assert.equal(provider?.id, "google_vision");
    assert.ok(provider?.version);
  });
});
