import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sessionPermissions } from "@/lib/agent/server/service.ts";
import { DRIVE_PERMISSIONS } from "@/lib/google/drive-readonly.ts";
import { driveArchive } from "@/lib/google/drive-server.ts";
import { catalogSyncStep } from "@/lib/google/catalog-sync.ts";
import { extractCatalogText } from "@/lib/google/catalog-extractor.ts";
import { catalogOcrStep } from "@/lib/google/catalog-ocr.ts";
import { catalogOcrConfig } from "@/lib/google/catalog-ocr-config.ts";
import { createOcrProvider } from "@/lib/ocr/providers/index.ts";
export const maxDuration=150;
export async function POST(request:Request) {
 if(request.headers.get("origin")!==new URL(request.url).origin)return new Response(null,{status:403});
 if(!request.headers.get("content-type")?.startsWith("application/json"))return new Response(null,{status:415});
 if(Number(request.headers.get("content-length")??0)>100)return new Response(null,{status:413});
 const userClient=await createClient();const {data:{user}}=await userClient.auth.getUser();
 if(!user)return new Response(null,{status:401});
 const codes=["agent.use",...DRIVE_PERMISSIONS,"documents.drive.text.view","prices.purchase.view"];
 const grants=await sessionPermissions(userClient)(codes);
 if(!codes.every(code=>grants.has(code)))return new Response(null,{status:403});
 let operation:string;
 try {const raw=await request.text();if(raw.length>100)throw new Error();const body=JSON.parse(raw);if(!body||Object.keys(body).length!==1||!["start","step","start_ocr","ocr_step"].includes(body.operation))throw new Error();operation=body.operation;}
 catch{return new Response(null,{status:400});}
 const admin=createAdminClient();if(!admin)return new Response(null,{status:503});
 const isOcr=operation==="start_ocr"||operation==="ocr_step";
 const ocr=catalogOcrConfig();
 if(isOcr&&!ocr.enabled)return Response.json({status:"unavailable",message:ocr.reason},{status:503,headers:{"Cache-Control":"no-store"}});
 const signal=AbortSignal.timeout(isOcr?110000:45000);
 // The server key can only call the narrow external-import RPC here; it never reads business data.
 const rpc=async(action:string,payload:Record<string,unknown>)=>{const result=await admin.rpc("drive_catalog_sync_step",{p_user_id:user.id,p_operation:action,p_payload:isOcr?{...payload,mode:"ocr"}:payload}).abortSignal(isOcr&&action==="save_text"?AbortSignal.timeout(8000):signal);if(result.error)throw new Error("CATALOG_UNAVAILABLE");return result.data;};
 const authorizeOcr=async(checkSignal:AbortSignal)=>{const fresh=await userClient.rpc("my_permissions",{p_codes:codes}).abortSignal(AbortSignal.any([checkSignal,AbortSignal.timeout(8000)]));return !fresh.error&&Array.isArray(fresh.data)&&codes.every(code=>fresh.data.includes(code));};
 try {const result=operation==="start" ? await rpc("start",{}) : operation==="start_ocr" ? await rpc("start_ocr",{batchSize:Math.min(20,ocr.config.limits.maxDocumentsPerRun)}) : isOcr ? await catalogOcrStep({rpc,drive:driveArchive,provider:createOcrProvider(ocr.config),limits:ocr.config.limits,authorize:authorizeOcr},signal) : await catalogSyncStep({rpc,drive:driveArchive,extract:(bytes,mime)=>extractCatalogText(bytes,mime,signal)},signal);
 return Response.json(result,{headers:{"Cache-Control":"no-store"}});}
 catch {return Response.json({status:"unavailable"},{status:503,headers:{"Cache-Control":"no-store"}});}
}
