import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Side-effect imports let Next trace the worker's external parser dependencies as well.
import "pizzip";
import "exceljs";
import "pdf-parse/lib/pdf-parse.js";
// The same PDF/DOCX/XLSX libraries as document-extraction/text.ts, in a disposable local worker.
export async function extractCatalogText(bytes:Uint8Array,mime:string,signal?:AbortSignal):Promise<string> {
 signal?.throwIfAborted();
 if(bytes.byteLength>4*1024*1024)throw new Error("CATALOG_FILE_LIMIT");
 const source=readFileSync(join(process.cwd(),"src/lib/google/catalog-text-worker.cjs"),"utf8");
 const worker=new Worker(source,{eval:true,execArgv:[],env:{},workerData:{bytes,mime,base:process.cwd()},resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:32}});
 return new Promise<string>((resolve,reject)=>{
  const stop=()=>{void worker.terminate();};
  const timer=setTimeout(()=>{done();reject(new Error("CATALOG_EXTRACT_TIMEOUT"));},15000);
  const abort=()=>{done();reject(new Error("CATALOG_EXTRACT_ABORTED"));};
  const done=()=>{clearTimeout(timer);signal?.removeEventListener("abort",abort);stop();};
  worker.once("message",(result:{text?:string;error?:string})=>{done();if(result.error){const error=new Error("CATALOG_EXTRACT_FAILED");if(result.error==="needs_ocr")error.name="NeedsOcrError";reject(error);}else resolve(result.text??"");});
  worker.once("error",()=>{done();reject(new Error("CATALOG_EXTRACT_FAILED"));});
  worker.once("exit",code=>{if(code!==0){done();reject(new Error("CATALOG_EXTRACT_FAILED"));}});
  signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
 });
}
