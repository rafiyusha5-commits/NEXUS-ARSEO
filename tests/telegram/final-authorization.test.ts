import assert from "node:assert/strict";
import { it } from "node:test";
import { processTelegramMessage } from "../../src/lib/telegram/pipeline.ts";
import { answered, harness, update } from "./pipeline-fakes.ts";

for (const kind of ["text", "file"] as const) it(`final ${kind} delivery denies unlink during the last permission check`, async () => {
  const h = harness(answered());
  h.granted.add("documents.drive.view");
  const open = h.deps.openSession;
  h.deps.openSession = async (...args) => {
    const session = await open(...args);
    const permissions = session.permissions;
    session.permissions = async codes => {
      // Reproduces the old gap: a separately read binding becomes stale here.
      if ([...h.db.updates.values()].some(r => r.status === "delivery_started")) h.db.linked = null;
      return permissions(codes);
    };
    session.data.downloadDriveFile = async () => ({ blob: new Blob(["PRIVATE_TEXT"]), filename: "Private.txt" });
    return session;
  };
  // The new check reads link + grants only after this in-flight change, as one snapshot.
  h.db.beforeAuthorization = () => { h.db.linked = null; };
  await processTelegramMessage(update(6301, { text: kind === "file" ? "/file Document_reference_123" : "Где поставка?" }), h.deps);
  assert.equal(h.bot.sent.length, 0); assert.equal(h.bot.documents.length, 0); assert.equal(h.closed, 1);
  assert.equal(h.db.updates.get(6301)?.status, "failed");
  assert.ok(h.db.calls.includes("telegram_authorize_delivery"));
});

it("the final authorization is the last awaited database operation before send", async () => {
  const h = harness(answered());
  const call = h.bot.call.bind(h.bot);
  h.bot.call = async (method, payload, options) => {
    if (method === "sendMessage") assert.equal(h.db.calls.at(-1), "telegram_authorize_delivery");
    return call(method, payload, options);
  };
  await processTelegramMessage(update(6302), h.deps);
  assert.equal(h.bot.sent.length, 1);
});

for (const kind of ["permission", "relink", "rpc-error", "non-boolean"] as const) it(`final authorization fails closed on ${kind}`, async () => {
  const h = harness(answered());
  const rpc = h.deps.rpc;
  h.deps.rpc = async (name, args) => {
    if (name === "telegram_authorize_delivery") {
      if (kind === "permission") h.granted.clear();
      if (kind === "relink") h.db.linked = "other-user";
      if (kind === "rpc-error") throw new Error("offline");
      if (kind === "non-boolean") return "true";
    }
    return rpc(name, args);
  };
  await processTelegramMessage(update(6303), h.deps);
  assert.equal(h.bot.sent.length, 0); assert.equal(h.closed, 1);
});
