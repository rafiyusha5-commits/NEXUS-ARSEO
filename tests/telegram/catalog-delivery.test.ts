import assert from "node:assert/strict";
import { it } from "node:test";
import { telegramDelivery } from "../../src/lib/telegram/format.ts";
import { TelegramClient, TelegramError } from "../../src/lib/telegram/client.ts";
import { processTelegramMessage } from "../../src/lib/telegram/pipeline.ts";
import { harness, update } from "./pipeline-fakes.ts";
import { ScriptedProvider, toolCall, finalAnswer, fakeData } from "../agent/fakes.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
const data = fakeData({ async findProducts({ offset, limit }) {
  return { rows: Array.from({ length: Math.min(limit, 31 - offset) }, (_, i) => ({ internal_sku: `FZ-${offset+i+1}`, name: { ru: `Шоколад Fazer ${offset+i+1} ${"название ".repeat(12)}` }, brand: "Fazer" })), total: 31 };
} });
const provider = () => new ScriptedProvider([toolCall("catalog", "find_products", { query: "Fazer", limit: 20 }), finalAnswer({ facts: [], commentary: [], limitations: [] })]);
function withCatalog(h: ReturnType<typeof harness>) {
  const open = h.deps.openSession;
  h.deps.openSession = async (...args) => ({ ...await open(...args), data });
}
it("automatically gathers all 31 products without requiring another question", async () => {
  const result = await TOOL_BY_NAME.get("find_products")!.run({ data, userId: "u", signal: new AbortController().signal }, { query: "Fazer" });
  assert.equal(result.truncated, false);
  assert.equal(result.rows[0].values.products_shown, 31);
  assert.equal(String(result.rows[0].values.product_list).split("\n").length, 31);
});
it("delivers the whole long answer as one file without truncating names or losing line breaks", async () => {
  const h = harness(provider()); withCatalog(h);
  await processTelegramMessage(update(901, { text: "Все товары Fazer" }), h.deps);
  assert.equal(h.bot.documents.length, 1);
  assert.match(h.bot.sent[0], /31 из 31/);
  assert.equal(h.bot.methods.filter(m => m === "sendDocument" || m === "sendMessage").length, 1);
  const text = await h.bot.documents[0].text();
  assert.match(text, /31\. FZ-31/);
  assert.match(text, /Всего найдено товаров: 31/);
  assert.equal((text.match(/\d+\. FZ-/g) ?? []).length, 31);
  assert.doesNotMatch(text, /название…/);
  assert.equal(h.db.updates.get(901)?.status, "completed");
});
it("withholds a full catalogue file if access is revoked during processing", async () => {
  const h = harness(new ScriptedProvider([toolCall("catalog", "find_products", { query: "Fazer" }), () => {
    h.granted.delete("agent.use"); return finalAnswer({ facts: [], commentary: [], limitations: [] });
  }])); withCatalog(h);
  await processTelegramMessage(update(902, { text: "Все товары Fazer" }), h.deps);
  assert.equal(h.bot.documents.length, 0);
  assert.doesNotMatch(h.bot.sent.join(), /FZ-|Шоколад/);
});
it("unknown file delivery is recorded without a second attempt", async () => {
  const h = harness(provider()); withCatalog(h); h.bot.sendError = new TelegramError("TELEGRAM_UNAVAILABLE");
  await processTelegramMessage(update(903, { text: "Все товары Fazer" }), h.deps);
  assert.equal(h.bot.documents.length, 1);
  assert.equal(h.db.updates.get(903)?.status, "delivery_unknown");
  await processTelegramMessage(update(903, { text: "Все товары Fazer" }), h.deps);
  assert.equal(h.bot.documents.length, 1);
});
it("uploads UTF-8 text using multipart without a JSON content-type", async () => {
  const bot = new TelegramClient("123456:" + "a".repeat(32), (async (_url, options) => {
    assert.ok(options?.body instanceof FormData);
    assert.equal(options?.headers, undefined);
    const file = (options!.body as FormData).get("document") as File;
    assert.equal(file.name, "nexus-answer.txt");
    assert.equal(await file.text(), "Полный список");
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch);
  await bot.call("sendDocument", { chat_id: 1, caption: "Каталог", document: new Blob(["Полный список"]) });
});
it("short catalogue replies retain newlines and their final product", () => {
  const delivery = telegramDelivery({ facts: [{ subject: "Каталог", source: { tool: "find_products", row: 0 }, values: [{ field: "product_list", label: "Товары", value: Array.from({ length: 20 }, (_, i) => `${i+1}. Товар ${i+1}`).join("\n") }] }], commentary: [], limitations: [], rejected: [], toolsUsed: [] }, 1, 20);
  assert.equal(delivery.document, undefined);
  assert.match(delivery.text, /\n20\. Товар 20/);
});

it("revoking a financial permission immediately before delivery suppresses both the file and text",async()=>{
 const h=harness(new ScriptedProvider([toolCall("price","get_system_record",{section:"product_prices",record_id:"11111111-1111-4111-8111-111111111111"}),finalAnswer({facts:[{call:"price",row:0,fields:["record_details"]}],commentary:[],limitations:[]})]));
 h.granted.add("products.view");h.granted.add("prices.purchase.view");
 const open=h.deps.openSession;
 h.deps.openSession=async(...args)=>({...await open(...args),data:fakeData({async readSystem(){return {rows:[{product_id:"11111111-1111-4111-8111-111111111111",base_purchase_price:77.66}],total:1};}})});
 const rpc=h.deps.rpc;let checks=0;
 h.deps.rpc=async(name,args)=>{if(name==="telegram_employee" && ++checks===2) h.granted.delete("prices.purchase.view");return rpc(name,args);};
 await processTelegramMessage(update(904,{text:"Цена"}),h.deps);
 assert.equal(h.bot.documents.length,0);assert.doesNotMatch(h.bot.sent.join(),/77[,.]66/);assert.equal(h.db.updates.get(904)?.error,"ANSWER_WITHHELD");
});
