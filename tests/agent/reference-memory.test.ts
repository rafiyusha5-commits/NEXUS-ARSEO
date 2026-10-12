import assert from "node:assert/strict";
import { it } from "node:test";
import { conversationMemory, referencesFromCalls } from "../../src/lib/agent/conversation.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { FakeLedger, ScriptedProvider, fakeData, toolCall, finalAnswer, permissionsOf, ALL_PERMISSIONS, TEST_LIMITS, TEST_PRICING, USER_ID } from "./fakes.ts";

const id = "Memory_document_123";
const version = "2026-10-11T00:00:00Z";
const grants = [...ALL_PERMISSIONS, "documents.drive.view", "documents.drive.text.view", "prices.purchase.view"];
const empty = () => finalAnswer({ facts: [], commentary: [], limitations: [] });
const base = { userId: USER_ID, channel: "web" as const, permissions: permissionsOf(grants), limits: TEST_LIMITS, pricing: TEST_PRICING };

it("Drive follow-up retains only a canonical reference, never document, OCR, price, secret or user query", async () => {
  const conversationKey = "drive-memory-safe";
  const key = JSON.stringify([USER_ID, "web", conversationKey]);
  const ledger = new FakeLedger();
  const first = new ScriptedProvider([toolCall("doc", "get_drive_document", { drive_id: id, query: "Цена 247 EUR" }), empty()]);
  const data = fakeData({ getDriveDocument: async () => ({ file: { id, name: "SECRET_DOCUMENT_NAME", path: "SECRET_DOCUMENT_PATH", mimeType: "text/plain", modifiedTime: version, textMethod: "ocr" }, text: "DOCUMENT_CONTENT Цена 247 EUR пароль: TulipRiver!", truncated: false }) });
  assert.equal((await runAgent("Прочти цену 247 EUR", { ...base, conversationKey, ledger, provider: first, data })).ok, true);
  const stored = conversationMemory.read(key);
  assert.equal(stored[0].id, id); assert.equal(stored[0].version, "2026-10-11T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(stored), /DOCUMENT_CONTENT|247|TulipRiver|SECRET_DOCUMENT_NAME|query/);
  let rereads = 0; let verified = 0;
  const next = new ScriptedProvider([toolCall("doc", "get_drive_document", { drive_id: id }), empty()]);
  const nextData = fakeData({ ...data, verifySystemAccess: async records => { verified++; assert.equal(records[0].ids[0], id); return true; },
    getDriveDocument: async () => { rereads++; return data.getDriveDocument!(id, AbortSignal.timeout(1000)); } });
  assert.equal((await runAgent("А его срок?", { ...base, conversationKey, ledger, provider: next, data: nextData })).ok, true);
  const initial = JSON.stringify(next.requests[0].messages);
  assert.ok(initial.includes(id)); assert.doesNotMatch(initial, /DOCUMENT_CONTENT|247 EUR|TulipRiver|SECRET_DOCUMENT_NAME/);
  assert.equal(rereads, 1); assert.ok(verified >= 2);
  assert.doesNotMatch(JSON.stringify(ledger), /DOCUMENT_CONTENT|247 EUR|TulipRiver|SECRET_DOCUMENT_NAME|Memory_document_123/);
});

it("memory source loss between provider iterations aborts instead of forwarding earlier model context", async () => {
  const conversationKey = "memory-between-iterations";
  conversationMemory.append(JSON.stringify([USER_ID, "web", conversationKey]), [{ section: "drive_text", id, version, access: { all: [], any: [] } }]);
  let visible = true;
  const provider = new ScriptedProvider([toolCall("help", "get_help", { topic: "documents" }), empty()]);
  const complete = provider.complete.bind(provider);
  provider.complete = async request => { const result = await complete(request); visible = false; return result; };
  const result = await runAgent("Что дальше?", { ...base, conversationKey, provider, ledger: new FakeLedger(), data: fakeData({ verifySystemAccess: async () => visible }) });
  assert.equal(result.ok, false); assert.equal(provider.requests.length, 1);
});

it("references are projected from verified rows; arbitrary params and unprovable RPC domains are not memory", () => {
  const tool = TOOL_BY_NAME.get("search_system")!;
  const refs = referencesFromCalls([{ tool, access: { all: ["products.view"], any: [] }, result: { rows: [{ subject: "SECRET", values: { query: "247 EUR" }, entity: { type: "system", section: "products", id: "11111111-1111-4111-8111-111111111111" } }], total: 1, truncated: false, notes: [] } }]);
  assert.equal(refs.length, 1); assert.equal(refs[0].section, "products"); assert.doesNotMatch(JSON.stringify(refs), /SECRET|247/);
});
