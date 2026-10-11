// Run only with react-server + server-condition.mjs. All I/O is mocked.
import assert from "node:assert/strict";
import type { SupabaseClient } from "@supabase/supabase-js";
import { catalogGateway } from "../../src/lib/google/catalog-gateway.ts";
const secret = "a".repeat(64);
const session = { auth: { getSession: async () => ({ data: { session: { access_token: "employee-jwt" } }, error: null }) } } as unknown as SupabaseClient;
const originalFetch = globalThis.fetch;
const names = ["DRIVE_CATALOG_GATEWAY_SECRET", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];
const originalEnv = names.map(name => process.env[name]);
try {
  delete process.env.DRIVE_CATALOG_GATEWAY_SECRET;
  await assert.rejects(catalogGateway(session), /CATALOG_UNAVAILABLE/);
  process.env.DRIVE_CATALOG_GATEWAY_SECRET = secret;
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://gateway.example.test";
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "public-test-key";
  await assert.rejects(catalogGateway({ auth: { getSession: async () => ({ data: { session: null }, error: null }) } } as unknown as SupabaseClient), /CATALOG_UNAVAILABLE/);
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(new URL(String(input)).origin, "https://gateway.example.test");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), "Bearer employee-jwt");
    assert.equal(headers.get("apikey"), "public-test-key");
    assert.equal(headers.get("x-nexus-drive-gateway"), secret);
    assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store");
    return Response.json([]);
  };
  const db = await catalogGateway(session);
  assert.equal((await db.from("drive_catalog_text").select("body")).error, null);
  assert.equal((await db.rpc("search_drive_catalog", { p_query: "example" })).error, null);
  assert.ok((await db.from("products").select("*")).error, "gateway refuses business table requests");
  assert.equal(requests, 2, "no request outside the allow-list reached the network mock");
  console.log("Drive gateway checks passed");
} finally {
  globalThis.fetch = originalFetch;
  names.forEach((name, index) => { if (originalEnv[index] === undefined) delete process.env[name]; else process.env[name] = originalEnv[index]; });
}
