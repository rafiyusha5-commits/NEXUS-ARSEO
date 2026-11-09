import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OcrPermissionError, persistOcrOutcome, recognizeDocument, type OcrDocument, type PipelineDeps } from "../../src/lib/ocr/pipeline.ts";
import { LOW_CONFIDENCE, proposeFromOcr, valueConfidence } from "../../src/lib/ocr/recognize.ts";
import { OcrError, type OcrInput, type OcrProvider, type OcrResult } from "../../src/lib/ocr/types.ts";
import { describeExtractionSummary } from "../../src/lib/document-extraction/summary.ts";
import { reviewDefinitions } from "../../src/lib/document-extraction/review-definitions.ts";
import { fakeDb, limits, pdfBytes, pngBytes } from "./helpers.ts";

const SCAN_TEXT = "Фамилия и инициалы водителя: Тестов Т.Т.\nГос.номер авто: 000TST00\nМарка авто: TESTTRUCK\nГос.номер прицепа: 00TRL00";
const ocrResult = (confidence: number | null, words?: OcrResult["words"]): OcrResult => ({
  text: SCAN_TEXT, pageCount: 1, confidence,
  words: words ?? SCAN_TEXT.split(/\s+/).map(text => ({ text, confidence: confidence ?? 0.9 })),
});

function provider(behaviour: (input: OcrInput, signal: AbortSignal) => Promise<OcrResult>) {
  const seen: OcrInput[] = [];
  const instance: OcrProvider = { id: "fake", version: "fake-1", async recognize(input, { signal }) { seen.push(input); return behaviour(input, signal); } };
  return { seen, instance };
}

const document = (bytes: Uint8Array): OcrDocument => ({ shipmentId: "s1", documentId: "d1", versionId: "v1", hintedKind: "driver_document", bytes });
const sha = async () => "a".repeat(64);
const deps = (overrides: Partial<PipelineDeps> & Pick<PipelineDeps, "db">): PipelineDeps => ({ provider: null, limits: limits(), now: (() => { let t = 1000; return () => (t += 250); })(), sha256: sha, ...overrides });
const claim = (action: string) => ({ begin_shipment_source_ocr: () => ({ data: { action, extraction_id: "e1", lease_started_at: "2030-01-01T00:00:00Z" } }) });

describe("OCR pipeline: nothing leaves without a provider and a valid file", () => {
  it("does not call the database or any provider when OCR is not configured", async () => {
    const { db, calls } = fakeDb({});
    const outcome = await recognizeDocument(deps({ db, provider: null }), document(pngBytes(800, 600)));
    assert.equal(outcome.state, "rejected");
    assert.match((outcome as { message: string }).message, /не настроено/);
    assert.equal(calls.length, 0);
  });

  it("rejects bad files before claiming a job or calling the provider", async () => {
    const { db, calls } = fakeDb({});
    const { seen, instance } = provider(async () => ocrResult(0.95));
    for (const bytes of [new TextEncoder().encode("not an image"), pngBytes(10, 10), await pdfBytes(6)]) {
      const outcome = await recognizeDocument(deps({ db, provider: instance }), document(bytes));
      assert.equal(outcome.state, "rejected");
    }
    assert.equal(calls.length, 0, "no job is claimed for a rejected file, so no attempt is spent");
    assert.equal(seen.length, 0);
  });
});

describe("OCR pipeline: permissions", () => {
  it("stops at the permission check of the database and never calls the provider", async () => {
    const { db } = fakeDb({ begin_shipment_source_ocr: () => ({ error: { code: "42501", message: "Нет права передавать документы на OCR" } }) });
    const { seen, instance } = provider(async () => ocrResult(0.95));
    await assert.rejects(recognizeDocument(deps({ db, provider: instance }), document(pngBytes(800, 600))), OcrPermissionError);
    assert.equal(seen.length, 0);
  });

  it("does not leak a database error text for other claim failures", async () => {
    const { db } = fakeDb({ begin_shipment_source_ocr: () => ({ error: { code: "XX000", message: "relation public.secret_table does not exist" } }) });
    const outcome = await recognizeDocument(deps({ db, provider: provider(async () => ocrResult(0.9)).instance }), document(pngBytes(800, 600)));
    assert.equal(outcome.state, "rejected");
    assert.equal(JSON.stringify(outcome).includes("secret_table"), false);
  });
});

describe("OCR pipeline: idempotent re-runs", () => {
  for (const action of ["reuse", "busy", "exhausted"] as const) {
    it(`'${action}' from the database means the provider is not called again`, async () => {
      const { db, calls } = fakeDb(claim(action));
      const { seen, instance } = provider(async () => ocrResult(0.95));
      const outcome = await recognizeDocument(deps({ db, provider: instance }), document(pngBytes(800, 600)));
      assert.equal(outcome.state, action === "reuse" ? "reused" : action);
      assert.equal(seen.length, 0);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].name, "begin_shipment_source_ocr");
    });
  }

  it("identifies the job by checksum, provider, provider version and the configured attempt limits", async () => {
    const { db, calls } = fakeDb(claim("run"));
    await recognizeDocument(deps({ db, provider: provider(async () => ocrResult(0.95)).instance, limits: limits({ maxAttempts: 2, leaseSeconds: 120 }) }), document(pngBytes(800, 600)), { force: true });
    assert.deepEqual(calls[0].args, {
      p_shipment_id: "s1", p_document_id: "d1", p_document_version_id: "v1", p_source_kind: "driver_document", p_source_sha256: "a".repeat(64),
      p_provider: "fake", p_provider_version: "fake-1", p_max_attempts: 2, p_lease_seconds: 120, p_force: true,
    });
  });

  it("calls the provider exactly once for a claimed job and hands over validated input only", async () => {
    const { db } = fakeDb(claim("run"));
    const { seen, instance } = provider(async () => ocrResult(0.95));
    const outcome = await recognizeDocument(deps({ db, provider: instance }), document(pngBytes(800, 600)));
    assert.equal(outcome.state, "recognized");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, "png");
    assert.equal(seen[0].mimeType, "image/png");
    assert.equal(seen[0].maxPages, 5);
  });
});

describe("OCR pipeline: errors and storing the proposal", () => {
  it("offers manual review for readable typed text without fields and persists an unconfirmed fenced result", async () => {
    const ocr = { text: "Wydanie zewnętrzne\nTowary dostarczone", pageCount: 2, confidence: 0.93, words: [] };
    const proposal = proposeFromOcr(ocr, "waybill");
    assert.equal(proposal.status, "needs_review");
    assert.equal(proposal.sourceKind, "waybill");
    assert.deepEqual(proposal.result.data, {});
    assert.deepEqual(proposal.result.evidence, {});
    assert.match(proposal.error ?? "", /введите данные вручную/);
    for (const sourceKind of ["invoice", "specification", "waybill", "contract", "transport_order", "vehicle_document", "driver_document"]) {
      assert.equal(proposeFromOcr(ocr, sourceKind).status, "needs_review");
      assert.ok(reviewDefinitions({ source_kind: sourceKind, extracted_data: {}, confirmed_data: {} }).length > 0, `${sourceKind} must expose fields for manual review`);
    }
    const { db, calls } = fakeDb({ finish_shipment_source_ocr_fenced: () => ({ data: "e1" }) });
    const saved = await persistOcrOutcome(deps({ db }), { state: "recognized", extractionId: "e1", leaseStartedAt: "2030-01-01T00:00:00Z", proposal, ocr, ms: 10 });
    assert.equal(saved.status, "needs_review");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "finish_shipment_source_ocr_fenced");
    assert.equal(calls[0].args.p_status, "needs_review");
    assert.equal(calls[0].args.p_lease_started_at, "2030-01-01T00:00:00Z");
    assert.deepEqual(calls[0].args.p_extracted_data, {});
    for (const hinted of ["other", "unrecognized_type"]) assert.equal(proposeFromOcr(ocr, hinted).status, "failed");
    assert.equal(proposeFromOcr({ ...ocr, text: " \n " }, "waybill").status, "failed");
  });
  it("records a provider failure as a failed row with a safe message and the time spent", async () => {
    const { db, calls } = fakeDb(claim("run"));
    const failing = provider(async () => { throw new OcrError("provider_error", "Сервис распознавания вернул ошибку 503", true); });
    const prepared = await recognizeDocument(deps({ db, provider: failing.instance }), document(pngBytes(800, 600)));
    assert.equal(prepared.state, "failed");
    const stored = await persistOcrOutcome(deps({ db, provider: failing.instance }), prepared);
    assert.equal(stored.status, "failed");
    const finish = calls.find(call => call.name === "finish_shipment_source_ocr_fenced")!;
    assert.equal(finish.args.p_status, "failed");
    assert.equal(finish.args.p_error_message, "Сервис распознавания вернул ошибку 503");
    assert.equal(typeof finish.args.p_processing_ms, "number");
  });

  it("hides the text of unexpected errors", async () => {
    const { db } = fakeDb(claim("run"));
    const crashing = provider(async () => { throw new Error("TypeError at /srv/app/secret/path with token abc123"); });
    const prepared = await recognizeDocument(deps({ db, provider: crashing.instance }), document(pngBytes(800, 600)));
    assert.equal(prepared.state, "failed");
    assert.equal(JSON.stringify(prepared).includes("abc123"), false);
  });

  it("aborts a provider that does not answer within the timeout", async () => {
    const { db } = fakeDb(claim("run"));
    const hanging = provider((_input, signal) => new Promise<OcrResult>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const prepared = await recognizeDocument(deps({ db, provider: hanging.instance, limits: limits({ timeoutMs: 40 }) }), document(pngBytes(800, 600)));
    assert.equal(prepared.state, "failed");
    assert.match((prepared as { message: string }).message, /не ответил вовремя/);
  });

  it("stores a proposal for review with method, confidence per field and timing, and can never confirm", async () => {
    const { db, calls } = fakeDb(claim("run"));
    const prepared = await recognizeDocument(deps({ db, provider: provider(async () => ocrResult(0.97)).instance }), document(pngBytes(800, 600)));
    const stored = await persistOcrOutcome(deps({ db }), prepared);
    assert.equal(stored.status, "extracted");
    const finish = calls.find(call => call.name === "finish_shipment_source_ocr_fenced")!;
    assert.equal(finish.args.p_extraction_id, "e1");
    assert.equal(finish.args.p_status, "extracted");
    assert.notEqual(finish.args.p_status, "confirmed");
    assert.equal((finish.args.p_extracted_data as Record<string, string>).vehicle_plate, "000TST00");
    const evidence = finish.args.p_field_evidence as Record<string, { confidence: number; method: string }>;
    assert.equal(evidence.vehicle_plate.method, "ocr");
    assert.ok(evidence.vehicle_plate.confidence > 0 && evidence.vehicle_plate.confidence <= 0.95, "never above the rule confidence");
    assert.equal(finish.args.p_page_count, 1);
    assert.equal(finish.args.p_confidence, 0.97);
    assert.equal(typeof finish.args.p_processing_ms, "number");
    assert.equal(calls.some(call => /shipment_transport|review_shipment|update/.test(call.name)), false, "OCR never writes to the shipment");
  });

  it("marks a proposal as needing review when documents disagree", async () => {
    const { db, calls } = fakeDb(claim("run"));
    const prepared = await recognizeDocument(deps({ db, provider: provider(async () => ocrResult(0.97)).instance }), document(pngBytes(800, 600)));
    await persistOcrOutcome(deps({ db }), prepared, [{ field: "vehicle_plate", values: ["a", "b"], documents: ["d1", "d2"] }]);
    assert.equal(calls.find(call => call.name === "finish_shipment_source_ocr_fenced")!.args.p_status, "needs_review");
  });

  it("reports a store failure instead of pretending the result was saved", async () => {
    const { db } = fakeDb({ ...claim("run"), finish_shipment_source_ocr_fenced: () => ({ error: { message: "lease lost" } }) });
    const prepared = await recognizeDocument(deps({ db, provider: provider(async () => ocrResult(0.97)).instance }), document(pngBytes(800, 600)));
    assert.deepEqual(await persistOcrOutcome(deps({ db }), prepared), { ok: false, status: "failed" });
  });
});

describe("field confidence", () => {
  it("scores a value by the words it was read from", () => {
    const words = [{ text: "Иванов", confidence: 0.9 }, { text: "И.И.", confidence: 0.5 }, { text: "other", confidence: 0.1 }];
    assert.equal(valueConfidence("Иванов И.И.", words), 0.7);
    assert.equal(valueConfidence("nothing here", words), null);
  });

  it("needs review when any field is uncertain, and fails when nothing was found", () => {
    const sure = proposeFromOcr(ocrResult(0.98), "other");
    assert.equal(sure.status, "extracted");
    assert.deepEqual(sure.lowConfidence, []);
    const blurry = ocrResult(0.9, [{ text: "000TST00", confidence: 0.4 }, { text: "Тестов", confidence: 0.95 }, { text: "Т.Т.", confidence: 0.95 }]);
    const proposal = proposeFromOcr(blurry, "other");
    assert.equal(proposal.status, "needs_review");
    assert.ok(proposal.lowConfidence.includes("vehicle_plate"));
    assert.ok(proposal.result.evidence.vehicle_plate.confidence < LOW_CONFIDENCE);
    const nothing = proposeFromOcr({ text: "just a picture of a cat", pageCount: 1, confidence: 0.9, words: [] }, "other");
    assert.equal(nothing.status, "failed");
    assert.match(nothing.error ?? "", /реквизиты не найдены/);
  });

  it("classifies the document from its text", () => {
    assert.equal(proposeFromOcr(ocrResult(0.98), "other").sourceKind, "other");
    const invoice = proposeFromOcr({ text: "Invoice № 12\nГос.номер авто: 000TST00", pageCount: 1, confidence: 0.95, words: [] }, "other");
    assert.equal(invoice.sourceKind, "invoice");
  });
});

describe("run summary wording", () => {
  it("names the four states and always says confirmation is needed", () => {
    const text = describeExtractionSummary({ ready: 2, review: 1, failed: 3, processing: 1, deferred: 2, reused: 4 });
    for (const part of ["Готово к проверке: 2", "нужна проверка: 1", "не прочитано: 3", "обрабатывается: 1", "ожидает следующего запуска: 2", "уже распознано ранее: 4", "только после вашего подтверждения"]) assert.ok(text.includes(part), part);
  });
});
