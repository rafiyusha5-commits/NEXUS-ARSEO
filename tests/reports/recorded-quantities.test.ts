import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import ts from "typescript";

const nativeRequire = createRequire(import.meta.url);
const item = { id: "i1", uom: "piece", ordered_quantity: 100, confirmed_quantity: null as number | null, shipped_quantity: null as number | null, accepted: 98, discrepancy: -2, product: { internal_sku: "SYNTHETIC" } };
const report = { shipment: { shipment_number: "TEST", status: "closed" }, items: [item], totals: { accepted: 98, batches: 98, movements: 98, reconciled: true, hasReceipt: true }, transports: [], stages: [], documents: [], missingDocuments: [], receipts: [], tasks: [], canViewPrices: false };
let exportedSheets: Array<{ name: string; rows: unknown[][] }> = [];
function load(relative: string) {
  const compiled = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const mod = { exports: {} as Record<string, (props: unknown, context?: unknown) => Promise<unknown>> };
  new Function("require", "module", "exports", compiled)((id: string) => {
    if (id === "@/lib/auth/access") return { requireUser: async () => ({ profile: {}, roles: [], supabase: {} }) };
    if (id === "@/lib/permissions") return { loadPermissions: async () => ({}) };
    if (id === "@/lib/documents/load-actions") return { loadDocumentActions: async () => ({}) };
    if (id === "@/components/documents/document-actions") return { DocumentActions: () => null };
    if (id === "@/lib/shipment-report") return { loadShipmentReport: async () => report, localizedName: () => "Synthetic", one: (value: unknown) => value };
    if (id === "@/lib/shipment-outcome") return { loadShipmentOutcome: async () => ({}) };
    if (id === "@/lib/shipment-outcome-workbook") return { outcomeWorkbookSheets: () => [] };
    if (id === "@/lib/xlsx") return { createXlsx: (sheets: typeof exportedSheets) => { exportedSheets = sheets; return Buffer.from("synthetic"); } };
    if (id === "@/components/app-sidebar") return { AppSidebar: () => null };
    if (id === "@/components/reports/shipment-outcome-sections") return { ShipmentOutcomeSections: () => null };
    if (id === "next/link") return { default: () => null };
    if (id === "next/navigation") return { notFound: () => { throw new Error("not found"); } };
    if (id === "next/server") return { NextResponse: Response };
    return nativeRequire(id);
  }, mod, mod.exports);
  return mod.exports;
}
const page = load("../../src/app/shipments/[id]/report/page.tsx").default;
const exportReport = load("../../src/app/shipments/[id]/report/export/route.ts").GET;

test("report and export distinguish missing evidence, explicit zero and recorded quantities", async () => {
  for (const [confirmed, shipped] of [[null, null], [0, null], [98, 0], [98, 97]] as const) {
    item.confirmed_quantity = confirmed;
    item.shipped_quantity = shipped;
    const html = renderToStaticMarkup(await page({ params: Promise.resolve({ id: "test" }) }) as ReactNode);
    const expectedConfirmed = confirmed === null ? "Не заполнено" : String(confirmed);
    const expectedShipped = shipped === null ? "Не заполнено" : String(shipped);
    assert.ok(html.includes(`<td>${expectedConfirmed}</td><td>${expectedShipped}</td><td>98</td>`), "actual page must not substitute ordered quantity");
    await exportReport(new Request("http://localhost/test"), { params: Promise.resolve({ id: "test" }) });
    const row = exportedSheets.find(sheet => sheet.name === "Позиции")!.rows[1];
    assert.deepEqual(row.slice(5, 9), [100, confirmed, shipped, 98]);
  }
});
