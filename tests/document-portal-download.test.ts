import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";

// Exercise the route with the portal RPC surface only. A staff table query or
// an unexpected call to Storage fails the test.
const documentId = "11111111-1111-4111-8111-111111111111";
const published = "22222222-2222-4222-8222-222222222222";
const other = "33333333-3333-4333-8333-333333333333";
const require = createRequire(import.meta.url);
async function request(version: string | null, allowed: boolean, visible = true) {
  const calls: string[] = [];
  const session = {
    async rpc(name: string, args?: { p_version_id: string }) {
      calls.push(name);
      if (name === "my_external_document_permissions") return { data: { download: allowed } };
      if (name === "my_external_document") return { data: visible ? [{ version_id: published }] : [] };
      if (name === "my_external_document_file") return { data: visible && args?.p_version_id === published
        ? [{ storage_path: "shared", original_filename: "example.pdf" }] : [] };
      assert.equal(name, "record_external_document_access");
      return { data: null };
    },
    storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://example.test/file" } }) }) },
  };
  const source = readFileSync(new URL("../src/app/portal/documents/[id]/download/route.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const mod = { exports: {} as { GET: (req: object, params: object) => Promise<Response> } };
  new Function("require", "module", "exports", js)((id: string) => {
    if (id === "@/lib/auth/access") return { requirePortalUser: async () => ({ supabase: session }) };
    if (id === "@/lib/documents/files.ts") return { DOCUMENT_BUCKET: "test" };
    if (id === "@/lib/documents/rules.ts") return { isUuid: (s: string) => [documentId, published, other].includes(s) };
    return require(id);
  }, mod, mod.exports);
  const url = new URL(`https://nexus.test/portal/documents/${documentId}/download`);
  if (version !== null) url.searchParams.set("version", version);
  const response = await mod.exports.GET({ url: url.href, nextUrl: url }, { params: Promise.resolve({ id: documentId }) });
  return { calls, location: response.headers.get("location") };
}
test("portal list downloads only the externally published version and records successful delivery", async () => {
  const result = await request(null, true);
  assert.equal(result.location, "https://example.test/file");
  assert.deepEqual(result.calls, ["my_external_document_permissions", "my_external_document", "my_external_document_file", "record_external_document_access"]);
  assert.deepEqual((await request(null, false)).calls, ["my_external_document_permissions"]);
  assert.deepEqual((await request(null, true, false)).calls, ["my_external_document_permissions", "my_external_document"]);
  assert.deepEqual((await request(other, true)).calls, ["my_external_document_permissions", "my_external_document_file"]);
});
