import assert from "node:assert/strict";
import { test } from "node:test";
import { compareCommodities, type CommodityLine } from "../../src/lib/document-extraction/commodity-evidence.ts";
import { evidenceOutcome } from "../../src/lib/document-check/evidence-outcome.ts";

const line: CommodityLine = { number: 1, sku: "SYNTH-A", description: "Synthetic", hsCode: "3924100000", quantity: 965, unit: "piece", amount: 965, grossKg: 10, netKg: 9, customsValue: 1000, warnings: [] };
const invoice = { number: "SYNTH-INV", currency: "EUR", total: 965, items: [line], warnings: [] };
const card = { sku: line.sku, unit: "piece", ordered: 1000, confirmed: 965, shipped: 965, hsCode: line.hsCode };
test("confirmed reading and matching invoice never erase the 35-piece order difference", () => {
  const comparisons = compareCommodities([line], "EUR", [invoice], [card]);
  assert.equal(comparisons[0].orderedDelta, -35);
  assert.equal(comparisons[0].status, "different");
  const result = evidenceOutcome(comparisons, true, true, []);
  assert.match(result.reading, /подтверждено/);
  assert.match(result.comparison, /совпадают/);
  assert.deepEqual(result.differences, ["SYNTH-A: -35 piece к заказу"]);
  assert.deepEqual(evidenceOutcome(comparisons, true, false, []).differences, result.differences);
});
test("inaccessible, stale or incomplete scope never emits quantities or identifiers", () => {
  const result = evidenceOutcome(compareCommodities([line], "EUR", [invoice], [card]), false, true, []);
  assert.deepEqual(result.differences, []);
  assert.doesNotMatch(JSON.stringify(result), /SYNTH|965|35/);
});
test("missing order or incompatible unit cannot be presented as zero difference", () => {
  for (const position of [{...card, ordered:null}, {...card, unit:"box"}]) {
    const result = compareCommodities([line], "EUR", [invoice], [position]);
    assert.equal(result[0].orderedDelta, null);
    assert.equal(result[0].orderedMatched, false);
  }
});
test("warnings, absent lines and absent invoice never produce a blanket match", () => {
  const comparisons = compareCommodities([line], "EUR", [invoice], [card]);
  assert.match(evidenceOutcome(comparisons, true, true, ["Incomplete"]).comparison, /недостаточно/);
  assert.match(evidenceOutcome([], true, true, []).comparison, /недостаточно/);
  assert.match(evidenceOutcome(compareCommodities([line], "EUR", [], [card]), true, true, []).comparison, /недостаточно/);
});
