import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import ts from "typescript";

// Performance measurement 25.11.2026, point 3: permission answers are shared within one server render, and document
// action batches are read in parallel. Synthetic clients only.
const nativeRequire = createRequire(import.meta.url);

function load(relative: string, deps: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(new URL(relative, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} as Record<string, (...args: never[]) => Promise<Record<string, unknown>>> };
  new Function("require", "module", "exports", code)((id: string) => (id in deps ? deps[id] : nativeRequire(id)), mod, mod.exports);
  return mod.exports;
}

// A render: React's cache returns one memoized value for the whole render. Outside a render it memoizes nothing.
function renderCache() {
  const values = new Map<unknown, unknown>();
  return <F extends () => unknown>(fn: F) => (() => { if (!values.has(fn)) values.set(fn, fn()); return values.get(fn); }) as F;
}
const noCache = <F,>(fn: F) => fn;

function permissionClient(granted: string[]) {
  const calls: string[][] = [];
  return { calls, rpc: async (name: string, args: { p_codes: string[] }) => { assert.equal(name, "my_permissions"); calls.push(args.p_codes); return { data: args.p_codes.filter(code => granted.includes(code)), error: null }; } };
}

describe("loadPermissions within one render", () => {
  it("answers codes the page already asked for without another request, and asks only for the missing ones", async () => {
    const { loadPermissions } = load("../src/lib/permissions.ts", { "server-only": {}, react: { cache: renderCache() } }) as unknown as { loadPermissions: (client: unknown, codes: string[]) => Promise<Record<string, boolean>> };
    const client = permissionClient(["shipments.view", "documents.view"]);
    assert.deepEqual(await loadPermissions(client, ["shipments.view", "documents.view", "tasks.create"]), { "shipments.view": true, "documents.view": true, "tasks.create": false });
    assert.deepEqual(await loadPermissions(client, ["documents.view", "shipments.view"]), { "documents.view": true, "shipments.view": true });
    assert.deepEqual(await loadPermissions(client, ["documents.view", "finance.view"]), { "documents.view": true, "finance.view": false });
    assert.deepEqual(client.calls, [["shipments.view", "documents.view", "tasks.create"], ["finance.view"]]);
  });

  it("never shares answers between clients", async () => {
    const { loadPermissions } = load("../src/lib/permissions.ts", { "server-only": {}, react: { cache: renderCache() } }) as unknown as { loadPermissions: (client: unknown, codes: string[]) => Promise<Record<string, boolean>> };
    const employee = permissionClient(["shipments.view"]), other = permissionClient([]);
    assert.equal((await loadPermissions(employee, ["shipments.view"]))["shipments.view"], true);
    assert.equal((await loadPermissions(other, ["shipments.view"]))["shipments.view"], false);
    assert.equal(other.calls.length, 1);
  });

  it("outside a render (server actions, route handlers) asks the database every time", async () => {
    const { loadPermissions } = load("../src/lib/permissions.ts", { "server-only": {}, react: { cache: noCache } }) as unknown as { loadPermissions: (client: unknown, codes: string[]) => Promise<Record<string, boolean>> };
    const client = permissionClient(["shipments.view"]);
    await loadPermissions(client, ["shipments.view"]);
    await loadPermissions(client, ["shipments.view"]);
    assert.equal(client.calls.length, 2);
  });
});

describe("loadDocumentActions", () => {
  it("reads the batches of 50 documents in parallel and indexes all of them", async () => {
    let inFlight = 0, peak = 0;
    const batches: string[][] = [];
    const answer = <T,>(value: T) => { inFlight++; peak = Math.max(peak, inFlight); return new Promise<T>(resolve => setTimeout(() => { inFlight--; resolve(value); }, 5)); };
    const query = (table: string) => {
      let mine: string[] = [];
      const chain = {
        select() { return chain; }, order() { return chain; }, range() { return chain; }, returns() { return chain; },
        in(column: string, values: string[]) { if (table === "documents" && column === "id") { mine = values; batches.push(values); } return chain; },
        then: (resolve: (value: unknown) => unknown) => answer(table === "documents" ? { data: mine.map(id => ({ id })), error: null } : { data: [], error: null }).then(resolve),
      };
      return chain;
    };
    const indexed: string[] = [];
    const { loadDocumentActions } = load("../src/lib/documents/load-actions.ts", {
      "../supabase/select-all": { selectAll: async (page: (from: number, to: number) => PromiseLike<unknown>) => page(0, 999) },
      "./action-index": { documentActionIndex: (documents: { id: string }[]) => Object.fromEntries(documents.map(document => { indexed.push(document.id); return [document.id, {}]; })) },
    }) as unknown as { loadDocumentActions: (session: unknown, ids: string[]) => Promise<Record<string, unknown>> };
    const ids = Array.from({ length: 120 }, (_, i) => `d${i}`);
    const index = await loadDocumentActions({ from: query }, [...ids, ids[0], null as unknown as string]);
    assert.deepEqual(batches.map(batch => batch.length), [50, 50, 20], "unique ids in batches of 50");
    assert.equal(Object.keys(index).length, 120);
    assert.ok(peak >= 6, `all batches (documents and sources) were in flight together, peak ${peak}`);
  });
});
