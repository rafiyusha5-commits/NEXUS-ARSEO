// Bounded resumable sync. All database mutation is confined to Nexus-owned catalog tables.
import { catalogText } from "./catalog-text.ts";
import type { DriveFile, DriveFolder, DriveReadonly } from "./drive-readonly.ts";
export type CatalogClaim = {status:string;runId?:string;token?:string;item?:DriveFile|DriveFolder};
export type CatalogSyncDeps = {
 rpc:(operation:string,payload:Record<string,unknown>)=>Promise<unknown>;
 drive:Pick<DriveReadonly,"catalogPage"|"catalogReference"|"download">;
 extract:(bytes:Uint8Array,mimeType:string)=>Promise<string>;
};
const FORMATS = new Set(["application/pdf","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","text/csv","text/plain","application/vnd.google-apps.document","application/vnd.google-apps.spreadsheet","application/vnd.google-apps.presentation"]);
export async function catalogSyncStep(deps:CatalogSyncDeps,signal:AbortSignal):Promise<CatalogClaim> {
 const claim=await deps.rpc("claim",{}) as CatalogClaim;
 if(!claim.token||!claim.item||!claim.runId)return claim;
 const receipt={runId:claim.runId,token:claim.token};
 if(claim.status==="scanning") {
  try {const page=await deps.drive.catalogPage(claim.item as DriveFolder,signal);return await deps.rpc("save_page",{...receipt,files:page.files,nextPage:page.nextPage}) as CatalogClaim;}
  catch {await deps.rpc("fail",receipt);return {status:"failed",runId:claim.runId};}
 }
 const file=claim.item as DriveFile;
 let status="unsupported";let prepared={text:"",truncated:false};
 if(file.mimeType.startsWith("image/"))status="needs_ocr";
 else if(FORMATS.has(file.mimeType)) {
  if(Number(file.size)>4*1024*1024)status="too_large";
  else try {
   const current=await deps.drive.catalogReference(file.id,file.ancestors??[],signal);
   if(Date.parse(current.modifiedTime??"")!==Date.parse(file.modifiedTime??""))status="changed";
   else {
    const download=await deps.drive.download(file.id,signal);
    if(download.blob.size>4*1024*1024)status="too_large";
    else {
     const mime=file.mimeType.startsWith("application/vnd.google-apps.") ? (file.mimeType.endsWith("spreadsheet") ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" : "application/pdf") : file.mimeType;
     const bytes=new Uint8Array(await download.blob.arrayBuffer());
     const text=mime==="text/plain" ? new TextDecoder().decode(bytes) : await deps.extract(bytes,mime);
     prepared=catalogText(text);status=prepared.text ? "readable" : "needs_ocr";
     const latest=await deps.drive.catalogReference(file.id,file.ancestors??[],signal);
     if(Date.parse(latest.modifiedTime??"")!==Date.parse(file.modifiedTime??"")) {status="changed";prepared={text:"",truncated:false};}
    }
   }
  } catch(error) {status=error instanceof Error && error.name==="NeedsOcrError" ? "needs_ocr" : "error";prepared={text:"",truncated:false};}
 }
 return await deps.rpc("save_text",{...receipt,status,...prepared}) as CatalogClaim;
}
