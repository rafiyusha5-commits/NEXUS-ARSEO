import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import * as quantities from "../../src/lib/shipments/document-quantities.ts";

// Render the actual server component; replace only Next's server-action and pending-button boundaries.
const nativeRequire = createRequire(import.meta.url);
const source = readFileSync(new URL("../../src/components/documents/document-quantities-form.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const componentModule = { exports: {} as { DocumentQuantitiesForm: (props: Record<string, unknown>) => ReactNode } };
new Function("require", "module", "exports", compiled)((id: string) => {
  if (id === "@/lib/shipments/document-quantities") return quantities;
  if (id === "@/app/shipments/source-document-actions") return { applyDocumentQuantitiesAction: "/synthetic-action" };
  if (id === "@/components/pending-submit-button") return { PendingSubmitButton: ({ children }: { children: ReactNode }) => createElement("button", null, children) };
  return nativeRequire(id);
}, componentModule, componentModule.exports);
const render = (lines: quantities.DocumentLine[], canApply = true) => renderToStaticMarkup(createElement(componentModule.exports.DocumentQuantitiesForm, {
  shipmentId: "s1", extractionId: "e1", sourceKind: "invoice", transportId: null, canApply, history: [], lines,
  items: [{ id: "i1", uom: "piece", shipment_transport_id: null, product: { internal_sku: "ABC-12", name: { en: "Chocolate" } }, ordered_quantity: 100, confirmed_quantity: 98, shipped_quantity: 97 }],
}));
test("quantity form keeps old values visible but never presents them as document evidence", () => {
  const html = render([]);
  assert.match(html, /<td>98<\/td>/);
  assert.match(html, /<td>97<\/td>/);
  assert.match(html, /name="qty_i1"[^>]*value=""/);
  assert.doesNotMatch(html, /name="qty_i1"[^>]*value="9[78]"/);
});
test("quantity form proposes an exact source, leaves ambiguous rows empty and has no write form when disabled", () => {
  assert.match(render([{ sku: "ABC-12", uom: "pcs", quantity: 12 }]), /name="qty_i1"[^>]*value="12"/);
  const uncertain = render([{ sku: "ABC-123", uom: "pcs", quantity: 12 }]);
  assert.match(uncertain, /Нужна ручная сверка всего документа/);
  assert.match(uncertain, /name="qty_i1"[^>]*value=""/);
  assert.doesNotMatch(render([], false), /<form|name="qty_/);
});
