import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as jsx from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import * as workflow from "../../src/lib/agent/shipment-workflow.ts";
import { isUuid } from "../../src/lib/documents/rules.ts";

const id = "00000000-0000-4000-8000-000000000001";
test("workspace uses session permissions, rejects hidden records and never mutates on GET", async () => {
  for (const mode of ["allowed", "denied", "hidden", "query-error", "disabled", "no-documents"] as const) {
    const code = ts.transpileModule(readFileSync(new URL("../../src/app/assistant/shipments/[id]/page.tsx", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
    let reads = 0;
    const query = { select() { return this; }, eq(_key: string, value: string) { assert.equal(value, id); return this; }, async maybeSingle() { reads++; return { data: mode === "hidden" ? null : { id, shipment_number: "NAR-SYNTHETIC", project_code: "SYNTHETIC" }, error: mode === "query-error" ? {} : null }; } };
    const deps: Record<string, unknown> = {
      "react/jsx-runtime": jsx, "next/link": { default: ({ children, href }: { children: ReactNode; href: string }) => jsx.jsx("a", { href, children }) },
      "next/navigation": { notFound() { throw Error("NOT_FOUND"); }, redirect() { throw Error("REDIRECT"); } },
      "@/components/app-sidebar": { AppSidebar: () => null },
      "@/components/workflow-help": { WorkflowHelp: () => null },
      "@/components/assistant/shipment-workflow-scope": { ShipmentWorkflowScope: ({ children }: { children: ReactNode }) => children },
      "@/components/documents/shipment-drive-folder-panel": { ShipmentDriveFolderPanel: () => jsx.jsx("p", { children: "EXISTING DRIVE PANEL" }) },
      "@/components/documents/shipment-source-documents-panel": { ShipmentSourceDocumentsPanel: () => jsx.jsx("p", { children: "EXISTING SOURCE PANEL" }) },
      "@/components/documents/shipment-document-check-panel": { ShipmentDocumentCheckPanel: () => jsx.jsx("p", { children: "EXISTING CHECK PANEL" }) },
      "@/lib/auth/access": (() => { const context = { profile: {}, roles: [], supabase: { from(name: string) { assert.equal(name, "shipments"); return query; }, rpc() { throw Error("GET_MUST_NOT_WRITE"); } } }; const loadPermissions = async (_: unknown, keys: string[]) => Object.fromEntries(keys.map(key => [key, mode !== "denied" && !(mode === "no-documents" && key === "documents.view")]));
        return { requireUser: async () => context, requirePageUser: async (keys: string[] = []) => ({ ...context, ...(keys.length ? { permissions: await loadPermissions(null, keys) } : {}) }) }; })(),
      "@/lib/permissions": { loadPermissions: async (_: unknown, keys: string[]) => Object.fromEntries(keys.map(key => [key, mode !== "denied" && !(mode === "no-documents" && key === "documents.view")])) },
      "@/lib/documents/rules": { isUuid }, "@/lib/agent/shipment-workflow": workflow,
    };
    const exports: { default?: (props: unknown) => Promise<ReactNode> } = {};
    runInNewContext(code, { exports, require: (key: string) => { assert.ok(key in deps, key); return deps[key]; }, process: { env: { AGENT_OPERATIONS_ENABLED: mode === "disabled" ? "false" : "true" } } });
    const render = () => exports.default!({ params: Promise.resolve({ id }), searchParams: Promise.resolve({ step: "review" }) });
    if (["denied", "hidden", "query-error", "disabled"].includes(mode)) await assert.rejects(render, /NOT_FOUND|REDIRECT/);
    else { const html = renderToStaticMarkup(await render()); assert.equal(html.includes("EXISTING SOURCE PANEL"), mode === "allowed"); assert.match(html, /ничего не проводит/); }
    assert.equal(reads, mode === "denied" || mode === "disabled" ? 0 : 1);
  }
});
