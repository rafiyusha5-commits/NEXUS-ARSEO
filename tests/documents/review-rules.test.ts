import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canSubmitDocumentForReview, validateDocumentDecision } from "../../src/lib/documents/review-rules.ts";

describe("document review workflow", () => {
  it("allows uploaded and rejected active documents to be resubmitted", () => {
    assert.equal(canSubmitDocumentForReview("uploaded", false), true);
    assert.equal(canSubmitDocumentForReview("rejected", false), true);
    assert.equal(canSubmitDocumentForReview("under_review", false), false);
    assert.equal(canSubmitDocumentForReview("approved", false), false);
    assert.equal(canSubmitDocumentForReview("uploaded", true), false);
  });

  it("requires a reason when rejecting", () => {
    assert.equal(validateDocumentDecision("rejected", ""), "При отклонении укажите причину");
    assert.equal(validateDocumentDecision("rejected", "неверная сумма"), null);
    assert.equal(validateDocumentDecision("approved", ""), null);
  });

  it("rejects unknown decisions and oversized comments", () => {
    assert.equal(validateDocumentDecision("cancelled", ""), "Некорректное решение");
    assert.equal(validateDocumentDecision("approved", "x".repeat(1001)), "Комментарий не должен превышать 1000 символов");
  });
});
