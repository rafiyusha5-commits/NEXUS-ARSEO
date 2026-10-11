import assert from "node:assert/strict";
import {it} from "node:test";
import {catalogText,catalogExcerpt,catalogExpiry} from "../src/lib/google/catalog-text.ts";
import {catalogSyncStep,type CatalogSyncDeps} from "../src/lib/google/catalog-sync.ts";
import {extractCatalogText} from "../src/lib/google/catalog-extractor.ts";
import {DRIVE_ROOT} from "../src/lib/google/drive-readonly.ts";
import {TOOL_BY_NAME} from "../src/lib/agent/tools.ts";
import {fakeData,USER_ID} from "./agent/fakes.ts";
import { FakeLedger,ScriptedProvider,toolCall,finalAnswer,TEST_LIMITS,TEST_PRICING,permissionsOf } from "./agent/fakes.ts";
import {runAgent} from "../src/lib/agent/runner.ts";
import {createRequire} from "node:module";
const require=createRequire(import.meta.url);
const id="1axwibtZqGf4lBDrYojBsBw64mJibfrIt";
const file={id,name:"ДС Belgian.pdf",mimeType:"application/pdf",path:"Belgian / ДС Belgian.pdf",ancestors:[DRIVE_ROOT],modifiedTime:"2026-10-11T00:00:00Z",size:"100"};
function harness(status="extracting") {
 const saves:{operation:string;payload:Record<string,unknown>}[]=[];
 const deps:CatalogSyncDeps={rpc:async(operation,payload)=>{saves.push({operation,payload});return operation==="claim" ? {status,runId:"run",token:"token",item:file} : {status};},drive:{catalogPage:async()=>({files:[file],nextPage:"next"}),catalogReference:async()=>file,download:async()=>({blob:new Blob(["PDF"]),filename:file.name})},extract:async()=>"Декларация действительна до 31.12.2027. Паспорт: AB12345678. Цена 2 EUR."};
 return {deps,saves};
}
it("catalog stores redacted extracted text and preserves permitted currency amounts and dates",()=>{
 const result=catalogText("Паспорт AB12345678, ИИН 900101300123, цена 2 EUR. Действительна до 31.12.2027.");
 assert.ok(!result.text.includes("AB12345678")&&!result.text.includes("900101300123"));assert.ok(result.text.includes("2 EUR"));assert.equal(catalogExpiry(result.text),"2027-12-31");
 assert.equal(catalogText("слово ".repeat(16000)).text.length,60000);assert.equal(catalogText("слово ".repeat(16000)).truncated,true);
});
it("expiry does not invent a deadline from an issue date, an invalid date, or conflicting dates",()=>{
 assert.equal(catalogExpiry("Выдано 31.12.2027"),null);assert.equal(catalogExpiry("Действительна до 29.02.2023"),null);
 assert.equal(catalogExpiry("Действует до 31.12.2027. Действует до 31.12.2028"),null);
 assert.match(catalogExcerpt("a".repeat(5000)+" Срок действия до 2027", "срок действия"),/Срок действия/);
});
it("one resumable scan saves the exact page and next cursor in Nexus only",async()=>{
 const h=harness("scanning");await catalogSyncStep(h.deps,AbortSignal.timeout(1000));
 assert.equal(h.saves.at(-1)?.operation,"save_page");assert.equal(h.saves.at(-1)?.payload.nextPage,"next");
});
it("an extraction step verifies source version twice and stores no passport",async()=>{
 const h=harness();let checks=0;h.deps.drive.catalogReference=async()=>{checks++;return file;};
 await catalogSyncStep(h.deps,AbortSignal.timeout(1000));const saved=h.saves.at(-1)!;
 assert.equal(saved.operation,"save_text");assert.equal(saved.payload.status,"readable");assert.ok(!String(saved.payload.text).includes("AB12345678"));assert.equal(checks,2);
});
it("changed source, scans and corrupt files have explicit states, never invented content",async()=>{
 const h=harness();h.deps.drive.catalogReference=async()=>({...file,modifiedTime:"2026-10-12T00:00:00Z"});
 await catalogSyncStep(h.deps,AbortSignal.timeout(1000));assert.equal(h.saves.at(-1)?.payload.status,"changed");assert.equal(h.saves.at(-1)?.payload.text,"");
 const scan=harness();scan.deps.extract=async()=>{const error=new Error();error.name="NeedsOcrError";throw error;};
 await catalogSyncStep(scan.deps,AbortSignal.timeout(1000));assert.equal(scan.saves.at(-1)?.payload.status,"needs_ocr");
 const broken=harness();broken.deps.extract=async()=>{throw new Error("CORRUPT");};await catalogSyncStep(broken.deps,AbortSignal.timeout(1000));assert.equal(broken.saves.at(-1)?.payload.status,"error");
});
it("content tool requires purchase-price permission, redacts again and refuses draft expiry",async()=>{
 const tool=TOOL_BY_NAME.get("get_drive_document")!;assert.ok(tool.permissions.includes("prices.purchase.view"));
 const result=await tool.run({userId:USER_ID,signal:AbortSignal.timeout(1000),data:fakeData({getDriveDocument:async()=>({file:{...file,name:"Макет ДС Belgian.docx",contentStatus:"readable"},text:"Действительна до 31.12.2027. ИИН 900101300123",truncated:false})})},{drive_id:id,query:"срок"});
 assert.equal(result.rows[0].values.expiry_date,undefined);assert.ok(!JSON.stringify(result).includes("900101300123"));assert.match(result.notes.join(" "),/макет|черновик/iu);
});
it("isolated worker reads DOCX, XLSX and PDF text locally with real parser libraries",async()=>{
 const Zip=require("pizzip");const zip=new Zip();zip.file("word/document.xml","<w:document><w:p>Декларация действительна до 31.12.2027</w:p></w:document>");
 assert.match(await extractCatalogText(zip.generate({type:"uint8array"}),"application/vnd.openxmlformats-officedocument.wordprocessingml.document"),/31.12.2027/);
 const Excel=require("exceljs");const book=new Excel.Workbook();book.addWorksheet("Товары").addRow(["Belgian","Кондитерские изделия"]);
 assert.match(await extractCatalogText(new Uint8Array(await book.xlsx.writeBuffer()),"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),/Belgian/);
 const {PDFDocument}=require("pdf-lib");const pdf=await PDFDocument.create();pdf.addPage().drawText("Declaration valid until 31.12.2027. Readonly original document.");
 assert.match(await extractCatalogText(await pdf.save({useObjectStreams:false}),"application/pdf"),/31.12.2027/);
});
it("worker stops on cancellation and rejects excessive file size without parsing",async()=>{
 const signal=AbortSignal.abort();await assert.rejects(extractCatalogText(new Uint8Array([1,2]),"application/pdf",signal));
 await assert.rejects(extractCatalogText(new Uint8Array(4*1024*1024+1),"application/pdf"));
});
it("the final access check carries the version actually used for the answer, even if the catalog updates during the model call",async()=>{
 const provider=new ScriptedProvider([toolCall("doc","get_drive_document",{drive_id:id,query:"срок"}),finalAnswer({facts:[{call:"doc",row:0,fields:["expiry_date"]}],commentary:[],limitations:[]})]);
 let captured:string|undefined;
 const data=fakeData({getDriveDocument:async()=>({file:{...file,contentStatus:"readable"},text:"Действует до 31.12.2027",truncated:false}),verifySystemAccess:async records=>{captured=records.find(record=>record.section==="drive_text")?.versions?.[id];return false;}});
 const result=await runAgent("Срок действия декларации Belgian",{channel:"web",userId:USER_ID,provider,ledger:new FakeLedger(),data,permissions:permissionsOf(["agent.use","documents.view","documents.drive.view","documents.drive.text.view","prices.purchase.view"]),limits:TEST_LIMITS,pricing:TEST_PRICING});
 assert.equal(captured,file.modifiedTime);assert.equal(result.ok,false);
});
