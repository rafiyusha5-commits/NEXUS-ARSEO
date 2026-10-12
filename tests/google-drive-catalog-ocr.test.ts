import assert from "node:assert/strict";
import { it } from "node:test";
import { PDFDocument } from "pdf-lib";
import { catalogOcrStep, type CatalogOcrDeps } from "../src/lib/google/catalog-ocr.ts";
import { catalogOcrConfig } from "../src/lib/google/catalog-ocr-config.ts";
import { loadOcrLimits } from "../src/lib/ocr/config.ts";
import { OcrError } from "../src/lib/ocr/types.ts";
import { DRIVE_ROOT } from "../src/lib/google/drive-readonly.ts";
import { TOOL_BY_NAME } from "../src/lib/agent/tools.ts";
import { fakeData, USER_ID } from "./agent/fakes.ts";

const file={id:"Catalog_ocr_document_123",name:"ДС скан.png",mimeType:"image/png",path:"Документы / ДС скан.png",ancestors:[DRIVE_ROOT],modifiedTime:"2026-10-11T00:00:00Z",size:"24"};
function png() { const bytes=new Uint8Array(24);bytes.set([137,80,78,71,13,10,26,10]);bytes.set([73,72,68,82],12);const view=new DataView(bytes.buffer);view.setUint32(16,100);view.setUint32(20,100);return bytes; }
function harness() {
 const saved:Record<string,unknown>[]=[];let calls=0;
 const deps:CatalogOcrDeps={authorize:async()=>true,limits:loadOcrLimits({}),rpc:async(operation,payload)=>{if(operation==="claim")return {status:"extracting",runId:"run",token:"token",item:file};saved.push(payload);return {status:"extracting"};},drive:{catalogPage:async()=>({files:[],nextPage:""}),catalogReference:async()=>file,download:async()=>({blob:new Blob([png()]),filename:file.name})},provider:{id:"http",version:"test",recognize:async()=>{calls++;return {text:"Действительна до 31.12.2027. ИИН 900101300123. Цена 2 EUR.",pageCount:1,confidence:.85,words:[]};}}};
 return {deps,saved,calls:()=>calls};
}
it("catalog OCR is separately enabled and cannot silently switch to Google Vision",()=>{
 const env={OCR_PROVIDER:"http",OCR_ACKNOWLEDGE_DATA_TRANSFER:"true",OCR_HTTP_ENDPOINT:"https://ocr.example.test/v1/recognize",OCR_HTTP_TOKEN:"secret"};
 assert.equal(catalogOcrConfig(env).enabled,false);assert.equal(catalogOcrConfig({...env,DRIVE_CATALOG_OCR_ENABLED:"true"}).enabled,true);
 assert.equal(catalogOcrConfig({...env,DRIVE_CATALOG_OCR_ENABLED:"true",OCR_PROVIDER:"google_vision",OCR_GOOGLE_VISION_API_KEY:"key"}).enabled,false);
 assert.equal(catalogOcrConfig({...env,DRIVE_CATALOG_OCR_ENABLED:"true",OCR_ACKNOWLEDGE_DATA_TRANSFER:"false"}).enabled,false);
});
it("OCR stores only masked text, validates actual image bytes and verifies source before and after",async()=>{
 const h=harness();let checks=0;h.deps.drive.catalogReference=async()=>{checks++;return file;};
 await catalogOcrStep(h.deps,AbortSignal.timeout(1000));assert.equal(checks,2);assert.equal(h.calls(),1);
 assert.equal(h.saved[0].status,"readable");assert.equal(h.saved[0].ocrConfidence,.85);assert.equal(h.saved[0].ocrPages,1);
 assert.ok(!String(h.saved[0].text).includes("900101300123"));assert.match(String(h.saved[0].text),/2 EUR/);
});
it("disabled, unsupported providers and aborted jobs do not claim or send a file",async()=>{
 for(const provider of [null,{id:"google_vision",version:"test",recognize:async()=>{throw new Error("MUST_NOT_SEND");}}]){
  const h=harness();h.deps.provider=provider;h.deps.rpc=async()=>{throw new Error("MUST_NOT_CLAIM");};await assert.rejects(catalogOcrStep(h.deps,AbortSignal.timeout(1000)),OcrError);
 }
 const h=harness();h.deps.rpc=async()=>{throw new Error("MUST_NOT_CLAIM");};await assert.rejects(catalogOcrStep(h.deps,AbortSignal.abort()));
});
it("revoked permission after download stops the file before it leaves Nexus for OCR",async()=>{
 const h=harness();h.deps.authorize=async()=>false;
 await catalogOcrStep(h.deps,AbortSignal.timeout(1000));assert.equal(h.calls(),0);assert.equal(h.saved[0].text,"");assert.equal(h.saved[0].ocrError,"disabled");
});
it("source moved or changed, wrong MIME, excessive bytes and exhausted retries cannot reach OCR",async()=>{
 for(const scenario of ["changed","moved","mime","size","exhausted"]){
  const h=harness();
  if(scenario==="changed")h.deps.drive.catalogReference=async()=>({...file,modifiedTime:"2026-10-12T00:00:00Z"});
  if(scenario==="moved")h.deps.drive.catalogReference=async()=>{throw new Error("DRIVE_READ_UNAVAILABLE");};
  if(scenario==="mime")h.deps.drive.download=async()=>({blob:new Blob(["%PDF-fake"]),filename:file.name});
  if(scenario==="size")h.deps.drive.download=async()=>({blob:new Blob([new Uint8Array(4*1024*1024+1)]),filename:file.name});
  if(scenario==="exhausted")h.deps.rpc=async(operation,payload)=>{if(operation==="claim")return {status:"extracting",runId:"run",token:"token",item:{...file,ocrExhausted:true}};h.saved.push(payload);return {status:"extracting"};};
  await catalogOcrStep(h.deps,AbortSignal.timeout(1000));assert.equal(h.calls(),0,scenario);assert.equal(h.saved[0].text,"");assert.notEqual(h.saved[0].status,"readable");
 }
});
it("a PDF above the page cap is rejected before calling the provider",async()=>{
 const pdf=await PDFDocument.create();for(let i=0;i<6;i++)pdf.addPage();const bytes=await pdf.save();
 const h=harness();const pdfFile={...file,mimeType:"application/pdf"};h.deps.rpc=async(operation,payload)=>{if(operation==="claim")return {status:"extracting",runId:"run",token:"token",item:pdfFile};h.saved.push(payload);return {status:"extracting"};};
 h.deps.drive.catalogReference=async()=>pdfFile;h.deps.drive.download=async()=>({blob:new Blob([new Uint8Array(bytes)]),filename:"scan.pdf"});
 await catalogOcrStep(h.deps,AbortSignal.timeout(1000));assert.equal(h.calls(),0);assert.equal(h.saved[0].ocrError,"too_many_pages");
});
it("provider failures and partial pages cannot persist a plausible but incomplete OCR text",async()=>{
 for(const scenario of ["timeout","empty","partial","changed_after"]){
  const h=harness();let checks=0;
  if(scenario==="changed_after")h.deps.drive.catalogReference=async()=>++checks===1?file:{...file,modifiedTime:"2026-10-12T00:00:00Z"};
  else h.deps.provider={id:"http",version:"test",recognize:async()=>{if(scenario==="partial")return {text:"Действительна до 31.12.2027",pageCount:2,confidence:.99,words:[]};throw new OcrError(scenario==="empty"?"empty":"timeout","safe");}};
  await catalogOcrStep(h.deps,AbortSignal.timeout(1000));assert.equal(h.saved[0].text,"");assert.notEqual(h.saved[0].status,"readable");
 }
});
it("the assistant labels OCR and never promotes its expiry date to a verified structured value",async()=>{
 const result=await TOOL_BY_NAME.get("get_drive_document")!.run({userId:USER_ID,signal:AbortSignal.timeout(1000),data:fakeData({getDriveDocument:async()=>({file:{...file,textMethod:"ocr",contentStatus:"readable"},text:"Действительна до 31.12.2027",truncated:false})})},{drive_id:file.id});
 assert.equal(result.rows[0].values.expiry_date,undefined);assert.match(String(result.rows[0].values.content_status),/OCR.*не проверено/);assert.match(result.notes.join(" "),/возможны ошибки/i);
});
