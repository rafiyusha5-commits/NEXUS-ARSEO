import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
type Element = { type?: unknown; props?: { children?: Element | Element[]; tabs?: { id: string; badge?: number }[] } };

async function documentBadge(tab: string, documents: number, letters: number) {
  const tabsComponent = () => null;
  const linkedCalls: string[][] = [];
  const sale = { id: "sale", customer_id: "customer", status: "draft", sale_number: "SYNTH", created_at: "2030-01-01", warehouse_id: "warehouse" };
  const session = {
    rpc: async () => ({ data: [] }),
    from(table: string) {
      const data = table === "sales" ? sale : table === "guarantee_letters" ? Array.from({ length: letters }, (_, i) => ({ id: `letter-${i}`, status: "draft", created_at: "2030-01-01" })) : [];
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "gt", "maybeSingle"]) chain[method] = () => chain;
      chain.then = (resolve: (result: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve);
      return chain;
    },
  };
  const code = ts.transpileModule(readFileSync(new URL("../src/app/sales/[id]/page.tsx", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const mod = { exports: {} as { default: (props: object) => Promise<Element> } };
  new Function("require", "module", "exports", code)((id: string) => {
    if (id === "react/jsx-runtime") return require(id);
    if (id === "@/lib/auth/access") return { requireUser: async () => ({ profile: {}, roles: [], supabase: session }) };
    if (id === "@/lib/supabase/select-all") return { selectAll: async () => ({ data: [] }) };
    if (id === "@/lib/sales/reservation-replacement") return { replacementPermissions: [], replacementUnits: {} };
    if (id === "@/components/operation-tabs") return { OperationTabs: tabsComponent };
    if (id === "@/components/documents/linked-documents") return {
      LinkedDocuments: () => null,
      linkedDocuments: async (client: unknown, type: string, ids: string[]) => {
        assert.equal(client, session, "count uses the employee session, never a privileged client");
        assert.equal(type, "customer"); linkedCalls.push(ids);
        return new Map(ids.includes("customer") ? [["customer", Array.from({ length: documents }, (_, i) => ({ actions: { id: `document-${i}` } }))]] : []);
      },
    };
    return new Proxy({}, { get: () => () => null });
  }, mod, mod.exports);
  const tree = await mod.exports.default({ params: Promise.resolve({ id: "sale" }), searchParams: Promise.resolve({ tab }) });
  function find(node: Element | Element[] | undefined): Element | undefined {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const child of node) { const result = find(child); if (result) return result; } return; }
    return node.type === tabsComponent ? node : find(node.props?.children);
  }
  return { badge: find(tree)?.props?.tabs?.find(t => t.id === "documents")?.badge, linkedCalls };
}

test("sale documents count includes visible client files on both the main and documents tabs", async () => {
  for (const tab of ["main", "documents"]) {
    const result = await documentBadge(tab, 8, 0);
    assert.equal(result.badge, 8);
    assert.deepEqual(result.linkedCalls, [["customer"]]);
  }
});

test("sale documents count includes guarantee letters without counting inaccessible client files", async () => {
  assert.equal((await documentBadge("documents", 2, 1)).badge, 3);
  assert.equal((await documentBadge("main", 0, 1)).badge, 1);
  assert.equal((await documentBadge("main", 0, 0)).badge, 0);
});
