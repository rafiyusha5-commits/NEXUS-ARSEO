import type { GoogleCalculatorImportResult } from "../../src/app/products/import/actions";

export const calls: string[] = [];
const snapshot = "a".repeat(64);
const schemaToken = "b".repeat(64);
let approved = false;
export async function runReferenceImport() { throw Error("Unexpected generic import"); }
export async function runGoogleCalculatorImport(mode: string, expected?: string, schema?: string): Promise<GoogleCalculatorImportResult> {
  calls.push(mode);
  document.getElementById("calls")!.textContent = calls.join(",");
  await new Promise(resolve => setTimeout(resolve, 300));
  const blocked = location.search.includes("blocked");
  if (mode === "approve-schema") {
    if (expected !== snapshot || schema !== schemaToken) throw Error("Approval lost snapshot");
    if (location.search.includes("stale")) return { ok: false, message: "Google Таблица изменилась после проверки. Выполните проверку без записи ещё раз." };
    approved = true;
  }
  if (!approved) return { ok: false, message: "Найдены изменения столбцов. Проверьте их ниже перед синхронизацией.", snapshot,
    schemaReview: { status: blocked ? "blocked" : "approval_required", current_count: 3, incoming_count: 5, expected_schema: schemaToken,
      added: [
        { key: "source.prices.new_price", field_ru: "Новая цена без НДС EUR", block: "УСТАНОВЛЕННЫЕ ЦЕНЫ", visibility: "sales" },
        { key: "source.prices.new_margin", field_ru: "Новая маржа", block: "УСТАНОВЛЕННЫЕ ЦЕНЫ", visibility: "confidential" },
      ], removed: [], changed: [] } };
  if (mode === "apply" && expected !== snapshot) throw Error("Apply lost snapshot");
  return { ok: true, snapshot, schemaApproved: mode === "approve-schema", skippedIssues: [], qualityIssues: [],
    source: { title: "Synthetic", sheet: "расчеты", spreadsheetId: "synthetic", rows: 6, columns: 5, products: 1 },
    report: { summary: { create: 1, update: 0, unchanged: 0, conflict: 0, error: 0 }, items: [],
      protectedFields: [
        { sku: "TEST-SHELF", field: "shelf_life_days", nexusValue: 540, sourceValue: 547 },
        { sku: "TEST-CODE", field: "hs_code", nexusValue: "0123456789", sourceValue: "01234567" },
      ], dryRun: mode !== "apply", applied: mode === "apply" } };
}
