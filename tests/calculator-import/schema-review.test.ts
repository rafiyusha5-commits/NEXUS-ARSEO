import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculatorSnapshotMatches, parseCalculatorSchemaReview } from "../../src/lib/calculator-import/schema-review.ts";

const review = { status: "approval_required", current_count: 3, incoming_count: 4, expected_schema: "a".repeat(64),
  added: [{ key: "source.prices.margin", field_ru: "Новая маржа", block: "УСТАНОВЛЕННЫЕ ЦЕНЫ", visibility: "confidential" }], removed: [], changed: [] };
describe("calculator schema review", () => {
  it("preserves explicit confidential classification in the review", () => {
    assert.deepEqual(parseCalculatorSchemaReview(review), review);
  });
  it("fails closed on incomplete or contradictory approval reports", () => {
    for (const input of [null, {}, { ...review, expected_schema: null }, { ...review, status: "success" },
      { ...review, added: [] }, { ...review, removed: review.added }, { ...review, incoming_count: 999 },
      { ...review, added: [{ ...review.added[0], visibility: "public" }] }]) assert.equal(parseCalculatorSchemaReview(input), null);
  });
  it("allows an initial read but requires an exact fresh snapshot for approval and apply", () => {
    assert.equal(calculatorSnapshotMatches("preview", "a".repeat(64)), true);
    for (const mode of ["approve-schema", "apply"] as const) {
      assert.equal(calculatorSnapshotMatches(mode, "a".repeat(64), "a".repeat(64)), true);
      for (const expected of [undefined, "", "a", "b".repeat(64)]) assert.equal(calculatorSnapshotMatches(mode, "a".repeat(64), expected), false);
    }
  });
});
