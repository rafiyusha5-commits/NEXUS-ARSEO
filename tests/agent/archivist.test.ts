import assert from "node:assert/strict";
import { it } from "node:test";
import { SYSTEM_SECTIONS, SYSTEM_PERMISSIONS, SYSTEM_BY_KEY } from "../../src/lib/agent/system-registry.ts";
import { TOOL_BY_NAME } from "../../src/lib/agent/tools.ts";
import { runAgent } from "../../src/lib/agent/runner.ts";
import { telegramDelivery } from "../../src/lib/telegram/format.ts";
import { FakeLedger, ScriptedProvider, fakeData, toolCall, finalAnswer, permissionsOf, TEST_LIMITS, TEST_PRICING, USER_ID, SECRET_VALUES, SHIPMENT_ID } from "./fakes.ts";
const empty={facts:[],commentary:[],limitations:[]};
const base=(provider:ScriptedProvider,grants:string[],data=fakeData())=>({channel:"telegram" as const,userId:USER_ID,provider,ledger:new FakeLedger(),data,permissions:permissionsOf(grants),limits:TEST_LIMITS,pricing:TEST_PRICING});
it("nutrition is read from the product with its basis and shown as verified data", async()=>{
 const provider=new ScriptedProvider([toolCall("p","search_system",{section:"products",query:"FZ-1",fields:"protein_g,fat_g,carbohydrates_g"}),finalAnswer({facts:[{call:"p",row:0,fields:["record_details"]}],commentary:[],limitations:[]})]);
 const data=fakeData({async readSystem(input){assert.equal(input.section,"products");return {rows:[{id:SHIPMENT_ID,internal_sku:"FZ-1",nutrition_facts:{basis:"100g",protein_g:6.5,fat_g:30,carbohydrates_g:58,driver_document:SECRET_VALUES.driverDocument},base_purchase_price:SECRET_VALUES.purchasePrice}],total:1};}});
 const result=await runAgent("Белки, жиры и углеводы FZ-1",base(provider,["agent.use","products.view"],data));assert.ok(result.ok);
 const detail=result.answer.facts[0].values[0].value;assert.match(detail,/На 100 г/);assert.match(detail,/Белки, г: 6,5/);assert.match(detail,/Углеводы, г: 58/);
 assert.ok(!provider.seen().includes(SECRET_VALUES.driverDocument));assert.ok(!provider.seen().includes(SECRET_VALUES.purchasePrice));
 assert.equal(result.answer.facts[0].link?.href,`/products/${SHIPMENT_ID}`);
});
it("missing nutrition is not invented or silently treated as zero",async()=>{
 const result=await TOOL_BY_NAME.get("get_system_record")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,nutrition_facts:{fat_g:0}}],total:1};}})},{section:"products",record_id:SHIPMENT_ID,fields:"protein_g,fat_g"});
 assert.match(String(result.rows[0].values.record_details),/основа не указана/);assert.match(String(result.rows[0].values.record_details),/Белки, г: не заполнено/);assert.match(String(result.rows[0].values.record_details),/Жиры, г: 0/);
});
it("hides financial scopes from an ordinary employee and refuses a direct forged call",async()=>{
 let reads=0;const provider=new ScriptedProvider([toolCall("c","get_system_record",{section:"product_prices",record_id:SHIPMENT_ID}),finalAnswer(empty)]);
 const d=base(provider,["agent.use","products.view"],fakeData({async readSystem(){reads++;return {rows:[],total:0};}}));await runAgent("Закупочная цена",d);
 const spec=provider.requests[0].tools.find(tool=>tool.name==="get_system_record")!;
 const properties=spec.parameters.properties as Record<string,{enum:string[]}>;assert.ok(!properties.section.enum.includes("product_prices"));assert.ok(properties.section.enum.includes("products"));
 assert.equal(reads,0);assert.equal(d.ledger.finished[0].tools[0].error,"PERMISSION_DENIED");
});
it("authorized prices remain visible in Telegram as values from the protected reader",async()=>{
 const provider=new ScriptedProvider([toolCall("c","get_system_record",{section:"product_prices",record_id:SHIPMENT_ID}),finalAnswer({facts:[{call:"c",row:0,fields:["record_details"]}],commentary:[],limitations:[]})]);
 const result=await runAgent("Закупочная цена товара",base(provider,["agent.use","products.view","prices.purchase.view"],fakeData({async readSystem(){return {rows:[{product_id:SHIPMENT_ID,base_purchase_price:12.34,currency_id:SHIPMENT_ID}],total:1};}})));
 assert.ok(result.ok);assert.match(telegramDelivery(result.answer,1,20).text,/Закупочная цена: 12,34/);
});
it("revoking financial access after reading prevents the answer from leaving the runner",async()=>{
 let granted=["agent.use","products.view","prices.purchase.view"];
 const provider=new ScriptedProvider([toolCall("c","get_system_record",{section:"product_prices",record_id:SHIPMENT_ID}),()=>{granted=granted.filter(code=>code!=="prices.purchase.view");return finalAnswer({facts:[{call:"c",row:0,fields:["record_details"]}],commentary:[],limitations:[]});}]);
 const d={...base(provider,granted,fakeData({async readSystem(){return {rows:[{product_id:SHIPMENT_ID,base_purchase_price:99}],total:1};}})),permissions:permissionsOf(()=>granted)};
 const result=await runAgent("Цена",d);assert.ok(!result.ok);assert.equal(result.code,"AGENT_FORBIDDEN");
});
it("all registered sections project away undeclared columns and raw secrets",async()=>{
 for(const section of SYSTEM_SECTIONS){
  const result=await TOOL_BY_NAME.get("search_system")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,product_id:SHIPMENT_ID,base_purchase_price:section.key==="product_prices"?10:SECRET_VALUES.purchasePrice,driver_document:SECRET_VALUES.driverDocument,driver_phone:SECRET_VALUES.driverPhone,raw_ocr:SECRET_VALUES.rawOcr,config:{apiKey:"secret"},access_token:"secret"}],total:1};}})},{section:section.key});
  const text=JSON.stringify(result);assert.ok(!text.includes(SECRET_VALUES.driverDocument),section.key);if(section.key!=="transports") assert.ok(!text.includes(SECRET_VALUES.driverPhone),section.key);assert.ok(!text.includes(SECRET_VALUES.rawOcr),section.key);
 }
 assert.ok(SYSTEM_PERMISSIONS.includes("prices.purchase.view"));assert.equal(SYSTEM_BY_KEY.get("cost_calculations")!.anyPermissions.includes("costing.view_assigned"),true);
});
it("only source-schema declared calculator columns are exposed; secret metadata is omitted",async()=>{
 const result=await TOOL_BY_NAME.get("get_system_record")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[{product_id:SHIPMENT_ID,source_key:"calc",catalog_data:{protein:6.5,extra:"HIDDEN",credential:"secret"},source_columns:[{key:"protein",field_ru:"Белки, г",visibility:"catalog"},{key:"credential",field_ru:"Пароль API",visibility:"catalog"}]}],total:1};}})},{section:"calculator",record_id:SHIPMENT_ID});
 assert.match(String(result.rows[0].values.record_details),/Белки, г: 6,5/);assert.doesNotMatch(JSON.stringify(result),/HIDDEN|secret/);
});

it("phone contacts and GTIN are rendered for the authorized employee without sending the values to the model",async()=>{
 const provider=new ScriptedProvider([toolCall("c","search_system",{section:"transports",parent_id:SHIPMENT_ID}),finalAnswer({facts:[{call:"c",row:0,fields:["record_details"]}],commentary:[],limitations:[]})]);
 const data=fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,driver_name:SECRET_VALUES.driverName,driver_phone:SECRET_VALUES.driverPhone,driver_document:SECRET_VALUES.driverDocument}],total:1};}});
 const result=await runAgent("Телефон водителя",base(provider,["agent.use","shipments.view"],data));assert.ok(result.ok);
 assert.ok(!provider.seen().includes(SECRET_VALUES.driverPhone));assert.ok(!provider.seen().includes(SECRET_VALUES.driverName));assert.ok(!provider.seen().includes(SECRET_VALUES.driverDocument));
 assert.ok(telegramDelivery(result.answer,1,20).text.includes(SECRET_VALUES.driverPhone));assert.ok(!JSON.stringify(result.answer).includes(SECRET_VALUES.driverDocument));
});

it("goods-cost expenses cannot bypass the separate purchase-price permission",async()=>{
 let reads=0;const provider=new ScriptedProvider([toolCall("e","search_system",{section:"expenses"}),finalAnswer(empty)]);
 const d=base(provider,["agent.use","finance.view"],fakeData({async readSystem(){reads++;return {rows:[{id:SHIPMENT_ID,expense_type:"goods_cost",amount:123.45}],total:1};}}));
 await runAgent("Расходы",d);assert.equal(reads,1);assert.ok(!provider.seen().includes("123.45"));assert.equal(d.ledger.finished[0].tools[0].error,"PERMISSION_DENIED");
});
it("large authorized monetary values are not mistaken for personal numbers",async()=>{
 const provider=new ScriptedProvider([toolCall("e","search_system",{section:"expenses"}),finalAnswer({facts:[{call:"e",row:0,fields:["record_details"]}],commentary:[],limitations:[]})]);
 const d=base(provider,["agent.use","finance.view"],fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,expense_type:"transport",amount:123456789,currency_id:SHIPMENT_ID,currency_code:"KZT"}],total:1};}}));
 const result=await runAgent("Расходы",d);assert.ok(result.ok);const text=telegramDelivery(result.answer,1,20).text;assert.match(text,/123[ \u00a0]456[ \u00a0]789/);assert.match(text,/KZT/);
});

it("a record that is reassigned or loses RLS visibility after reading is withheld",async()=>{
 const provider=new ScriptedProvider([toolCall("p","search_system",{section:"products",query:"FZ"}),finalAnswer({facts:[{call:"p",row:0,fields:["record_details"]}],commentary:[],limitations:[]})]);
 const result=await runAgent("Товар",base(provider,["agent.use","products.view"],fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,internal_sku:"FZ"}],total:1};},async verifySystemAccess(){return false;}})));
 assert.ok(!result.ok);assert.equal(result.code,"AGENT_FORBIDDEN");
});
it("a broader costing role cannot silently downgrade to assigned-only after reading another shipment",async()=>{
 let grants=["agent.use","prices.purchase.view","costing.view","costing.view_assigned"];
 const provider=new ScriptedProvider([toolCall("c","search_system",{section:"cost_calculations"}),()=>{grants=grants.filter(code=>code!=="costing.view");return finalAnswer(empty);}]);
 const result=await runAgent("Себестоимость",{...base(provider,grants,fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,landed_total:25}],total:1};}})),permissions:permissionsOf(()=>grants)});
 assert.ok(!result.ok);assert.equal(result.code,"AGENT_FORBIDDEN");
});
it("two system calls preserve both sets of server-generated facts",async()=>{
 const provider=new ScriptedProvider([toolCall("p","search_system",{section:"products",query:"A"}),toolCall("p2","search_system",{section:"products",query:"B"}),finalAnswer(empty)]);
 const result=await runAgent("Оба товара",base(provider,["agent.use","products.view"],fakeData({async readSystem(input){return {rows:[{id:SHIPMENT_ID,internal_sku:input.query}],total:1};}})));
 assert.ok(result.ok);assert.equal(result.answer.facts.length,2);assert.match(result.answer.facts[0].subject,/A/);assert.match(result.answer.facts[1].subject,/B/);
});

it("unknown requested field names do not discard authorized nutrition or reveal undeclared data",async()=>{
 const result=await TOOL_BY_NAME.get("search_system")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[{id:SHIPMENT_ID,internal_sku:"153",name:{ru:"Печенье"},nutrition_facts:{basis:"100g",protein_g:5.1,fat_g:23,carbohydrates_g:64},driver_document:SECRET_VALUES.driverDocument,base_purchase_price:SECRET_VALUES.purchasePrice}],total:1};}})},{section:"products",query:"153",fields:"name,article,references"});
 const text=JSON.stringify(result);assert.match(text,/Белки, г: 5,1/);assert.match(text,/Жиры, г: 23/);assert.match(text,/Углеводы, г: 64/);assert.ok(!text.includes(SECRET_VALUES.driverDocument));assert.ok(!text.includes(SECRET_VALUES.purchasePrice));assert.equal(result.rows[0].values.record_id,SHIPMENT_ID);
});
it("a unique catalogue match supplies the product UUID for reading nutrition and related packaging",async()=>{
 const result=await TOOL_BY_NAME.get("find_products")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async findProducts(){return {rows:[{id:SHIPMENT_ID,internal_sku:"153",name:{ru:"Печенье"}}],total:1};}})},{query:"153"});
 assert.equal(result.rows[0].references?.product_id,SHIPMENT_ID);
 const ambiguous=await TOOL_BY_NAME.get("find_products")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async findProducts(){return {rows:[{id:SHIPMENT_ID,internal_sku:"153"},{id:USER_ID,internal_sku:"1530"}],total:2};}})},{query:"153"});
 assert.equal(ambiguous.rows[0].references,undefined);
});
it("a pallet quantity answer excludes intermediate product cards and other packaging rows",async()=>{
 const provider=new ScriptedProvider([toolCall("p","search_system",{section:"products",query:"178"}),toolCall("pk","search_system",{section:"packaging",parent_id:SHIPMENT_ID}),finalAnswer({facts:[{call:"pk",row:1,fields:["units_per_parent","uom"]}],commentary:[],limitations:[]})]);
 const result=await runAgent("Сколько штук на паллете артикула 178",base(provider,["agent.use","products.view"],fakeData({async readSystem(input){return input.section==="products"?{rows:[{id:SHIPMENT_ID,internal_sku:"178",composition:"НЕ НУЖНЫЙ СОСТАВ"}],total:1}:{rows:[{id:USER_ID,product_id:SHIPMENT_ID,uom:"box",units_per_parent:18},{id:SHIPMENT_ID,product_id:SHIPMENT_ID,uom:"pallet",units_per_parent:1152}],total:2};}})));
 assert.ok(result.ok);assert.equal(result.answer.facts.length,1);const text=telegramDelivery(result.answer,1,20).text;assert.match(text,/1[ \u00a0]152/);assert.match(text,/Паллета/);assert.doesNotMatch(text,/НЕ НУЖНЫЙ СОСТАВ|Короб/);
});
it("purchase price can be read narrowly from the protected calculator without dumping product details",async()=>{
 const row={product_id:SHIPMENT_ID,source_key:"calc",catalog_data:{composition:"НЕ НУЖНЫЙ СОСТАВ"},source_columns:[{key:"purchase",field_ru:"Цена за единицу",block:"Информация о закупе",visibility:"confidential"},{key:"old",field_ru:"Предыдущая цена",block:"Информация о закупе",visibility:"confidential"}],confidential_data:{purchase:0.99,old:1.15}};
 const result=await TOOL_BY_NAME.get("get_system_record")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[row],total:1};}})},{section:"calculator_finance",record_id:SHIPMENT_ID,fields:"base_purchase_price,price_source,currency_code"});
 assert.equal(result.rows[0].values.base_purchase_price,0.99);assert.equal(result.rows[0].values.currency_code,"Не указана в источнике");assert.match(String(result.rows[0].values.record_details),/Закупочная цена: 0,99/);assert.doesNotMatch(String(result.rows[0].values.record_details),/НЕ НУЖНЫЙ СОСТАВ|Предыдущая цена|1,15/);
 const ordinary=await TOOL_BY_NAME.get("get_system_record")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[row],total:1};}})},{section:"calculator",record_id:SHIPMENT_ID});
 assert.equal(ordinary.rows[0].values.base_purchase_price,undefined);assert.doesNotMatch(JSON.stringify(ordinary),/0,99|1,15/);
});
it("missing calculator purchase price is never converted into zero",async()=>{
 const result=await TOOL_BY_NAME.get("get_system_record")!.run({userId:USER_ID,signal:new AbortController().signal,data:fakeData({async readSystem(){return {rows:[{product_id:SHIPMENT_ID,source_columns:[{key:"purchase",field_ru:"Цена за единицу",block:"Информация о закупе",visibility:"confidential"}],confidential_data:{purchase:null}}],total:1};}})},{section:"calculator_finance",record_id:SHIPMENT_ID,fields:"base_purchase_price"});assert.equal(result.rows[0].values.base_purchase_price,undefined);
});