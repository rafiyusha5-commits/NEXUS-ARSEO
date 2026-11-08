import assert from "node:assert/strict";
import { it } from "node:test";
import { parseReport } from "../../src/lib/reference-import/report.ts";
const base = { summary: { create: 0, update: 0, unchanged: 1, conflict: 0, error: 0 }, items: [] };
it("preserves the direction and types of source/catalogue differences", () => {
  const report = parseReport({ ...base, protected_fields: [
    { sku: "TEST-1", field: "shelf_life_days", nexus_value: 540, source_value: 547 },
    { sku: "TEST-2", field: "hs_code", nexus_value: "0123456789", source_value: "01234567" },
  ] });
  assert.deepEqual(report?.protectedFields, [
    { sku: "TEST-1", field: "shelf_life_days", nexusValue: 540, sourceValue: 547 },
    { sku: "TEST-2", field: "hs_code", nexusValue: "0123456789", sourceValue: "01234567" },
  ]);
  assert.equal(parseReport(base)?.protectedFields, undefined);
});
it("rejects malformed protected fields and unexpected financial fields", () => {
  for (const item of [null, {}, { sku: "X", field: "base_purchase_price", nexus_value: 1, source_value: 2 },
    { sku: "X", field: "hs_code", nexus_value: {}, source_value: "123" },
    { sku: "X", field: "shelf_life_days", nexus_value: 540, source_value: "547" },
    { sku: "X", field: "shelf_life_days", nexus_value: 540, source_value: Infinity }]) {
    assert.equal(parseReport({ ...base, protected_fields: [item] }), null);
  }
  assert.equal(parseReport({ ...base, protected_fields: {} }), null);
});
