import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditCalculatorPackaging } from "../../src/lib/calculator-import/quality.ts";
import type { CalculatorImportPackage } from "../../src/lib/calculator-import/parser.ts";

function calculator(packaging: Array<Record<string, unknown>>): CalculatorImportPackage {
  return {
    format: "nexus-calculator-import",
    version: 1,
    reference: {
      format: "nexus-reference-import",
      version: 1,
      counterparties: [],
      products: [{ row: 6, internal_sku: "SKU-1", name: { ru: "Товар" }, manufacturer: "Завод", identifiers: [], packaging }],
    },
    source: {
      key: "arseo-master-calculator",
      title: "Master",
      sheet_name: "расчеты",
      header_rows: 5,
      header_fingerprint: "schema",
      columns: [],
      rows: [{ row: 6, internal_sku: "SKU-1", category: null, catalog_data: {}, sales_data: {}, confidential_data: {} }],
    },
  } as unknown as CalculatorImportPackage;
}

describe("calculator packaging quality", () => {
  it("accepts an exact hierarchy expressed in product pieces", () => {
    const issues = auditCalculatorPackaging(calculator([
      { uom: "piece", units_per_parent: 1, net_weight_kg: 0.175, gross_weight_kg: 0.18 },
      { uom: "box", units_per_parent: 22, gross_weight_kg: 4.34 },
      { uom: "pallet", units_per_parent: 1760, gross_weight_kg: 341.8 },
      { uom: "truck", units_per_parent: 58080, gross_weight_kg: 11279.4 },
    ]));
    assert.deepEqual(issues, []);
  });

  it("reports missing levels, broken ratios and impossible gross weights", () => {
    const issues = auditCalculatorPackaging(calculator([
      { uom: "piece", units_per_parent: 1, net_weight_kg: 0.2, gross_weight_kg: 0.19 },
      { uom: "box", units_per_parent: 12, gross_weight_kg: 2 },
      { uom: "pallet", units_per_parent: 100 },
    ]));
    assert.deepEqual(issues.map((issue) => issue.kind), ["missing", "quantity", "weight", "weight"]);
    assert.ok(issues.every((issue) => issue.row === 6 && issue.sku === "SKU-1"));
  });
});
