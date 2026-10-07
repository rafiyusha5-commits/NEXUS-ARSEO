import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { describeOcrConfig, loadOcrConfig } from "../../src/lib/ocr/config.ts";
import { OcrError } from "../../src/lib/ocr/types.ts";
import { detectOcrKind, inspectOcrFile } from "../../src/lib/ocr/validate.ts";
import { encryptedLooking, jpegBytes, limits, pdfBytes, pngBytes } from "./helpers.ts";

describe("OCR configuration", () => {
  it("sends nothing anywhere by default", () => {
    assert.equal(loadOcrConfig({}).provider, "disabled");
    assert.equal(loadOcrConfig({ OCR_PROVIDER: "disabled" }).provider, "disabled");
  });

  it("needs an explicit acknowledgement of the data transfer, not only a provider name", () => {
    const config = loadOcrConfig({ OCR_PROVIDER: "google_vision", OCR_GOOGLE_VISION_API_KEY: "k" });
    assert.equal(config.provider, "disabled");
    assert.match((config as { reason: string }).reason, /OCR_ACKNOWLEDGE_DATA_TRANSFER/);
  });

  it("stays disabled when credentials are missing or malformed", () => {
    const ack = { OCR_ACKNOWLEDGE_DATA_TRANSFER: "true" };
    assert.equal(loadOcrConfig({ ...ack, OCR_PROVIDER: "google_vision" }).provider, "disabled");
    assert.equal(loadOcrConfig({ ...ack, OCR_PROVIDER: "http", OCR_HTTP_ENDPOINT: "https://ocr.example", OCR_HTTP_TOKEN: "" }).provider, "disabled");
    assert.equal(loadOcrConfig({ ...ack, OCR_PROVIDER: "http", OCR_HTTP_ENDPOINT: "http://ocr.example/v1", OCR_HTTP_TOKEN: "t" }).provider, "disabled", "plain http is refused");
    assert.equal(loadOcrConfig({ ...ack, OCR_PROVIDER: "http", OCR_HTTP_ENDPOINT: "https://user:pass@ocr.example/v1", OCR_HTTP_TOKEN: "t" }).provider, "disabled", "credentials in the URL are refused");
    assert.equal(loadOcrConfig({ ...ack, OCR_PROVIDER: "http", OCR_HTTP_ENDPOINT: "not a url", OCR_HTTP_TOKEN: "t" }).provider, "disabled");
    assert.equal(loadOcrConfig({ ...ack, OCR_PROVIDER: "something-else" }).provider, "disabled");
  });

  it("accepts a fully configured provider and clamps every limit", () => {
    const config = loadOcrConfig({ OCR_PROVIDER: "google_vision", OCR_ACKNOWLEDGE_DATA_TRANSFER: "true", OCR_GOOGLE_VISION_API_KEY: "secret-key", OCR_MAX_PAGES: "999", OCR_MAX_FILE_BYTES: "999999999", OCR_TIMEOUT_MS: "1", OCR_MAX_ATTEMPTS: "0" });
    assert.equal(config.provider, "google_vision");
    assert.equal(config.limits.maxPages, 10);
    assert.equal(config.limits.maxFileBytes, 4 * 1024 * 1024, "never above the upload cap");
    assert.equal(config.limits.timeoutMs, 2000);
    assert.equal(config.limits.maxAttempts, 1);
  });

  it("never exposes keys, tokens or endpoints to the interface", () => {
    const config = loadOcrConfig({ OCR_PROVIDER: "http", OCR_ACKNOWLEDGE_DATA_TRANSFER: "true", OCR_HTTP_ENDPOINT: "https://internal.example/ocr", OCR_HTTP_TOKEN: "super-secret-token" });
    const shown = JSON.stringify(describeOcrConfig(config));
    assert.equal(shown.includes("super-secret-token"), false);
    assert.equal(shown.includes("internal.example"), false);
    assert.deepEqual(describeOcrConfig(config), { enabled: true, provider: "http", reason: "" });
  });
});

describe("OCR file validation", () => {
  const expectError = async (promise: Promise<unknown>, code: string) => {
    await assert.rejects(promise, (error: unknown) => error instanceof OcrError && error.code === code);
  };

  it("decides the kind from the bytes, not from a name or declared type", () => {
    assert.equal(detectOcrKind(pngBytes(100, 100)), "png");
    assert.equal(detectOcrKind(jpegBytes(100, 100)), "jpeg");
    assert.equal(detectOcrKind(new TextEncoder().encode("%PDF-1.7")), "pdf");
    assert.equal(detectOcrKind(new TextEncoder().encode("MZ executable renamed to scan.jpg")), null);
  });

  it("accepts a normal scan, a photo and a short PDF", async () => {
    assert.deepEqual(await inspectOcrFile(pngBytes(1600, 1200), limits()), { kind: "png", mimeType: "image/png", pageCount: 1, width: 1600, height: 1200 });
    assert.equal((await inspectOcrFile(jpegBytes(3000, 2000), limits())).kind, "jpeg");
    assert.equal((await inspectOcrFile(await pdfBytes(3), limits())).pageCount, 3);
  });

  it("refuses unsupported, empty, oversized and over-paged files before anything is sent", async () => {
    await expectError(inspectOcrFile(new Uint8Array(), limits()), "invalid_file");
    await expectError(inspectOcrFile(new TextEncoder().encode("just text"), limits()), "unsupported");
    await expectError(inspectOcrFile(new Uint8Array(2048).fill(1), limits({ maxFileBytes: 1024 })), "too_large");
    await expectError(inspectOcrFile(await pdfBytes(6), limits({ maxPages: 5 })), "too_many_pages");
  });

  it("refuses encrypted PDFs and broken or huge images", async () => {
    await expectError(inspectOcrFile(encryptedLooking(), limits()), "invalid_file");
    await expectError(inspectOcrFile(pngBytes(10, 10), limits()), "invalid_file");
    await expectError(inspectOcrFile(pngBytes(20000, 20000), limits()), "too_large");
    await expectError(inspectOcrFile(jpegBytes(9000, 9000), limits({ maxPixels: 40_000_000 })), "too_large");
    const truncated = pngBytes(500, 500).subarray(0, 12);
    await expectError(inspectOcrFile(truncated, limits()), "invalid_file");
  });
});
