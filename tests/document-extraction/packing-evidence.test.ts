import assert from "node:assert/strict";
import { test } from "node:test";
import { comparePackingQuantities, parsePackingEvidence } from "../../src/lib/document-extraction/packing-evidence.ts";
import { extractShipmentFields } from "../../src/lib/document-extraction/rules.ts";
import type { CommodityLine } from "../../src/lib/document-extraction/commodity-evidence.ts";

const raw = `DESPATCH NOTE/ ORDER NR: WZ 12/01/2030EX
1 123456 1234567890123 Synthetic candy 100g 2 (20 ) 2.000 01.01.2031 LOT1
Recipient SKU: synthetic
1 123456 1234567890123 Synthetic candy 100g 3 (30 ) 3.000 02.01.2031 LOT2
2 654321 1234567890124 Synthetic bar 50g 1 (5 ) 0.250 01.01.2031 LOT3
Total: 6 (55 ) 5.250`;
const line = (sku: string, quantity: number): CommodityLine => ({ number: 1, sku, quantity, unit: "ШТ", description: "Synthetic", amount: 1, grossKg: 1, netKg: 1, customsValue: 1, hsCode: "1806901900", warnings: [] });
test("packing OCR reads explicit pieces, aggregates lots and does not double a translation", () => {
  const p = parsePackingEvidence(raw)!;
  assert.equal(p.total, 55); assert.equal(p.items.length, 3); assert.deepEqual(p.warnings, []);
  assert.deepEqual(extractShipmentFields(raw).data.packing_evidence, p);
  assert.deepEqual(parsePackingEvidence(raw.replace("DESPATCH", "DISPATCH")), p);
  const result = comparePackingQuantities([line("123456", 50), line("654321", 5)], ["WZ 12/01/2030EX"], [p, structuredClone(p)]);
  assert.equal(result.matched, true); assert.deepEqual(result.differences, []);
});
test("missing rows, wrong total, foreign number and conflicting translations never match", () => {
  const p = parsePackingEvidence(raw)!;
  for (const sources of [[{ ...p, total: 56 }], [{ ...p, number: "OTHER" }], [{ ...p, items: [] }], [p, { ...p, total: 56, items: [{ sku: "123456", unit: "piece", quantity: 56 }] }]]) {
    assert.equal(comparePackingQuantities([line("123456", 50), line("654321", 5)], [p.number!], sources).matched, false);
  }
  assert.ok(parsePackingEvidence(raw.replace("3 (30 )", "3 (??? )"))!.warnings.length);
});
test("extra SKU and wrong units are explicit differences, not a blanket match", () => {
  const p = parsePackingEvidence(raw)!;
  assert.equal(comparePackingQuantities([line("123456", 50)], [p.number!], [p]).matched, false);
  assert.equal(comparePackingQuantities([{ ...line("123456", 50), unit: "box" }, line("654321", 5)], [p.number!], [p]).matched, false);
});
