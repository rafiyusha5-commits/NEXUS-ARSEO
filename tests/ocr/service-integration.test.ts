import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HttpOcrProvider } from "../../src/lib/ocr/providers/http.ts";
import { proposeFromOcr } from "../../src/lib/ocr/recognize.ts";
import { inspectOcrFile } from "../../src/lib/ocr/validate.ts";
import { limits } from "./helpers.ts";

// Optional end-to-end check against YOUR OWN nexus-ocr service (never an external one). It runs only when
// NEXUS_OCR_TEST_URL (https, or http://127.0.0.1 for a local container) and NEXUS_OCR_TEST_TOKEN are set, and sends
// nothing but the synthetic documents from tests/fixtures/ocr. Example with a local container:
//   docker run -d -e OCR_SERVICE_TOKEN=<40+ chars> -p 127.0.0.1:18080:8080 nexus-ocr:local
//   NEXUS_OCR_TEST_URL=http://127.0.0.1:18080/v1/recognize NEXUS_OCR_TEST_TOKEN=<token> pnpm test
const url = process.env.NEXUS_OCR_TEST_URL ?? "";
const token = process.env.NEXUS_OCR_TEST_TOKEN ?? "";
const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
const enabled = !!url && !!token && (url.startsWith("https://") || local);
const fixture = (name: string) => new Uint8Array(readFileSync(join(import.meta.dirname, "..", "fixtures", "ocr", name)));

describe("live nexus-ocr service", { skip: enabled ? false : "set NEXUS_OCR_TEST_URL and NEXUS_OCR_TEST_TOKEN to run" }, () => {
  const provider = () => new HttpOcrProvider(url, token);
  const read = async (name: string, kind: "png" | "jpeg" | "pdf") => {
    const bytes = fixture(name);
    const inspected = await inspectOcrFile(bytes, limits());
    assert.equal(inspected.kind, kind);
    const ocr = await provider().recognize({ bytes, kind, mimeType: inspected.mimeType, maxPages: 5, languageHints: ["ru", "kk", "en"] }, { signal: AbortSignal.timeout(60_000) });
    return proposeFromOcr(ocr, "other");
  };

  it("reads a PNG, a JPEG and a scanned PDF", async () => {
    for (const [name, kind] of [["ru.png", "png"], ["scan.pdf", "pdf"]] as const) {
      const { result } = await read(name, kind);
      assert.equal(result.data.driver_name, "Иванов Иван Иванович", name);
      assert.equal(result.data.driver_phone, "+7 701 123 45 67", name);
    }
    const kaz = await read("kaz.jpg", "jpeg");
    assert.equal(kaz.result.data.driver_name, "Әбдірахманов Қайрат Ұлықбекұлы");
  });

  it("reads the identity-card imitation and refuses empty forms", async () => {
    const card = await read("idcard.png", "png");
    assert.equal(card.result.data.driver_document, "123456789");
    assert.equal(card.result.data.driver_name, "ТОЛЫБАЙ АНУАР СЕРІКБОЛАТҰЛЫ");
    for (const name of ["empty_fields.png", "labels_only.png"]) assert.deepEqual((await read(name, "png")).result.data, {}, name);
  });

  it("does not answer without a valid token", async () => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: "{}" });
    assert.equal(response.status, 401);
  });
});
