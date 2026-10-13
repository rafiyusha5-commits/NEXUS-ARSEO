import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { proposeFromOcr } from "../../src/lib/ocr/recognize.ts";
import { persistOcrOutcome } from "../../src/lib/ocr/pipeline.ts";
import { fakeDb, limits } from "./helpers.ts";

describe("manual review after OCR reads a document without supported field labels", () => {
  const ocr = { text: "Wydanie zewnętrzne\nTowary dostarczone", pageCount: 2, confidence: 0.93, words: [] };

  it("opens review for a selected waybill without inventing any values", () => {
    const proposal = proposeFromOcr(ocr, "waybill");
    assert.equal(proposal.status, "needs_review");
    assert.equal(proposal.sourceKind, "waybill");
    assert.deepEqual(proposal.result.data, {});
    assert.deepEqual(proposal.result.evidence, {});
    assert.match(proposal.error ?? "", /введите данные вручную/);
  });

  it("persists the proposal as awaiting review, never as confirmed", async () => {
    const { db, calls } = fakeDb({ finish_shipment_source_ocr: () => ({ data: "e1" }) });
    const proposal = proposeFromOcr(ocr, "waybill");
    const stored = await persistOcrOutcome({ db, provider: null, limits: limits(), now: () => 1000, sha256: async () => "a".repeat(64) }, {
      state: "recognized", extractionId: "e1", proposal, ocr, ms: 10,
    });
    assert.equal(stored.status, "needs_review");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "finish_shipment_source_ocr");
    assert.equal(calls[0].args.p_status, "needs_review");
    assert.deepEqual(calls[0].args.p_extracted_data, {});
  });

  it("still fails for an empty OCR result or unclassified text", () => {
    assert.equal(proposeFromOcr({ ...ocr, text: " \n " }, "waybill").status, "failed");
    assert.equal(proposeFromOcr(ocr, "other").status, "failed");
  });
});
