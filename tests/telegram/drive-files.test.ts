import assert from "node:assert/strict";
import { it } from "node:test";
import { processTelegramMessage, TELEGRAM_TEXT } from "../../src/lib/telegram/pipeline.ts";
import { harness, answered, update, CHAT } from "./pipeline-fakes.ts";
import { ScriptedProvider, fakeData, toolCall, finalAnswer } from "../agent/fakes.ts";
const fileId = "1axwibtZqGf4lBDrYojBsBw64mJibfrIt";
it("search renders a file button from a verified result, not a model URL", async () => {
  const provider = new ScriptedProvider([toolCall("drive1", "find_drive_documents", { query: "Belgian ДС", offset: null }), finalAnswer({ facts: [{ call: "drive1", row: 0, fields: ["file_name"] }], commentary: [], limitations: [] })]);
  const h = harness(provider); h.granted.add("documents.drive.view"); h.granted.add("documents.view"); h.deps.botUsername = "NEXUS_ARSEO_bot";
  const open = h.deps.openSession;
  h.deps.openSession = async (...args) => { const s = await open(...args); s.data = fakeData({ findDriveDocuments: async () => ({ files: [{ id: fileId, name: "ДС Belgian.pdf", mimeType: "application/pdf", path: "Belgian / Сертификаты / ДС Belgian.pdf" }], total: 1, truncated: false }) }); return s; };
  let markup: unknown; const call = h.bot.call.bind(h.bot);
  h.bot.call = async (method, payload, options) => { if (method === "sendMessage") markup = payload?.reply_markup; return call(method, payload, options); };
  await processTelegramMessage(update(5105, { text: "Найди декларацию Belgian" }), h.deps);
  assert.deepEqual(markup, { inline_keyboard: [[{ text: "Получить: ДС Belgian.pdf", url: `https://t.me/NEXUS_ARSEO_bot?start=drive_${fileId}` }]] });
});
function setup() {
  const h = harness(answered()); let downloads = 0;
  const original = h.deps.openSession;
  h.deps.openSession = async (...args) => { const s = await original(...args); s.data.downloadDriveFile = async () => { downloads++; return { blob: new Blob(["PDF"]), filename: "ДС Belgian.pdf" }; }; return s; };
  return { h, downloads: () => downloads };
}
it("a linked employee requests a file explicitly, one delivery to their own chat, no model or question charge", async () => {
  const { h, downloads } = setup(); h.granted.add("documents.drive.view"); h.granted.add("documents.view");
  await processTelegramMessage(update(5100, { text: `/start drive_${fileId}` }), h.deps);
  assert.equal(downloads(), 1); assert.equal(h.bot.documents.length, 1); assert.equal(h.bot.sent[0], "ДС Belgian.pdf");
  assert.equal(h.ledger.reservations.length, 0); assert.equal(h.closed, 1);
  await processTelegramMessage(update(5100, { text: `/file ${fileId}` }), h.deps); assert.equal(h.bot.documents.length, 1);
});
it("lack of archive permission stops download even when document permission exists", async () => {
  const { h, downloads } = setup(); h.granted.delete("documents.drive.view");
  await processTelegramMessage(update(5101, { text: `/file ${fileId}` }), h.deps);
  assert.equal(downloads(), 0); assert.equal(h.bot.documents.length, 0); assert.equal(h.bot.sent[0], TELEGRAM_TEXT.withheld);
});
it("rights revoked after download or a relinked chat withholds the file", async () => {
  const { h } = setup(); h.granted.add("documents.drive.view");
  const open = h.deps.openSession;
  h.deps.openSession = async (...args) => { const s = await open(...args); const download = s.data.downloadDriveFile!;
    s.data.downloadDriveFile = async (...input) => { const file = await download(...input); h.granted.delete("documents.drive.view"); return file; }; return s; };
  await processTelegramMessage(update(5102, { text: `/file ${fileId}` }), h.deps);
  assert.equal(h.bot.documents.length, 0); assert.equal(h.bot.sent[0], TELEGRAM_TEXT.withheld);
});
it("a group and an unlinked chat cannot request a file", async () => {
  const { h, downloads } = setup(); h.db.linked = null;
  await processTelegramMessage(update(5103, { text: `/file ${fileId}` }), h.deps);
  await processTelegramMessage({ update_id: 5104, message: { chat: { id: CHAT, type: "group" }, text: `/file ${fileId}` } }, h.deps);
  assert.equal(downloads(), 0); assert.equal(h.bot.documents.length, 0);
});
