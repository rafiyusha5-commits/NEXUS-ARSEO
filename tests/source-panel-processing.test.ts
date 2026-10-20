import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import ts from "typescript";
import * as status from "../src/lib/documents/processing-status.ts";

const nativeRequire = createRequire(import.meta.url);
const now = Date.parse("2030-01-01T00:05:00Z");
let vehicles: unknown[] = [];
let allowed = true;
const extraction = {
  id: "synthetic-ocr", document_id: "d", document_version_id: "v",
  source_kind: "other", status: "pending", document: null,
  extracted_data: {}, confirmed_data: {}, field_evidence: {}, conflicts: [],
  updated_at: "2030-01-01T00:00:00Z", processing_started_at: "2030-01-01T00:00:00Z",
  ocr_lease_until: "2030-01-01T00:02:00Z" as string | null,
};
function query(table: string) {
  const data = table === "shipment_source_extractions" ? [extraction]
    : table === "shipment_transports" ? vehicles
      : table === "shipments" ? { shipment_number: "SYNTH", type: "import" } : [];
  const result = { data, count: Array.isArray(data) ? data.length : 1, error: null };
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "neq", "order", "maybeSingle"]) chain[method] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return chain;
}
function load(relative: string): Record<string, unknown> {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", code)((id: string) => {
    if (id === "./processing-status") return load("../src/components/documents/processing-status.tsx");
    if (id === "@/lib/documents/processing-status") return status;
    if (id === "@/lib/documents/processing-clock") return { loadProcessingClock: async () => now };
    if (id === "@/lib/supabase/server") return { createClient: async () => ({ from: query }) };
    if (id === "@/lib/permissions") return { loadPermissions: async () => ({ "documents.view": allowed }) };
    if (id === "@/lib/document-extraction/rules") return { SOURCE_FIELD_DEFINITIONS: [], VEHICLE_SCOPED_FIELDS: [] };
    if (id === "@/lib/shipments/document-quantities") return { QUANTITY_SOURCE_KINDS: [] };
    if (id === "@/lib/document-extraction/commodity-evidence") return { currentCommoditySource: () => false, isCommodityInvoice: () => false };
    if (id === "@/lib/document-extraction/packing-evidence") return { isPackingEvidence: () => false };
    if (id === "@/lib/ocr/config") return { loadOcrConfig: () => ({}), describeOcrConfig: () => ({ enabled: true }) };
    if (id === "@/lib/ocr/recognize") return { LOW_CONFIDENCE: 0.8 };
    if (id === "@/lib/shipments/transport-form") return { describeTransport: () => "Synthetic vehicle" };
    if (id.startsWith("@/") || id.startsWith("./") || id === "next/link") return new Proxy({}, { get: () => () => null });
    return nativeRequire(id);
  }, mod, mod.exports);
  return mod.exports;
}
const panel = load("../src/components/documents/shipment-source-documents-panel.tsx").ShipmentSourceDocumentsPanel as
  (props: { shipmentId: string }) => Promise<ReactNode>;

test("actual source panel shows expired OCR with zero vehicles and with vehicles", async () => {
  for (vehicles of [[], [{ id: "vehicle", sequence_no: 1, status: "planned" }]]) {
    for (const lease of [null, "2030-01-01T00:02:00Z", "2030-01-01T00:10:00Z"]) {
      extraction.ocr_lease_until = lease;
      const html = renderToStaticMarkup(await panel({ shipmentId: "synthetic" }));
      assert.ok(html.includes('aria-label="Последние операции"'));
      assert.ok(html.includes(lease?.endsWith("10:00Z") ? "Выполняется" : "Требуется действие сотрудника"));
      assert.ok(!html.includes("Документ обрабатывается. Обновите страницу"));
    }
  }
  allowed = false;
  assert.equal(renderToStaticMarkup(await panel({ shipmentId: "synthetic" })), "");
  allowed = true;
});
