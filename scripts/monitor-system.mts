// Explicit operator invocation. Does not read .env, enable schedules, create buckets or restart work.
import { readFile,writeFile,mkdir,open,unlink,stat } from "node:fs/promises";
import { join,isAbsolute,relative,resolve } from "node:path";
import {randomUUID} from "node:crypto";
import {environment,jobCode,configuredJobPolicy,type JobFacts,type Observation} from "../src/lib/monitoring/policy.ts";
import {probeDependencies} from "../src/lib/monitoring/probes.ts";
import {monitoringClient,recordObservation} from "../src/lib/monitoring/client.ts";
import {appendSafeLog} from "../src/lib/monitoring/local-log.ts";
import {verifyBackup} from "../src/lib/monitoring/backup.ts";
import {windowPolicy,expectedOnline,policyHash,observeApplication,transition,readObserverState,deliverTechnical} from "../src/lib/monitoring/observer.ts";

const env=environment(process.env.MONITORING_ENVIRONMENT);
const mode=process.argv[2];
const dir=process.env.MONITORING_LOG_DIRECTORY;
async function main(){
 if(process.env.MONITORING_ENABLED!=="true"||!env||!dir||!isAbsolute(dir)||!["collect","observe"].includes(mode)||process.argv.length!==3)throw Error("MONITORING_CONFIG_REQUIRED");
 const fromPublic=relative(resolve(process.cwd(),'public'),resolve(dir));
 if(!fromPublic||(!fromPublic.startsWith('..')&&!isAbsolute(fromPublic)))throw Error('MONITORING_PRIVATE_DIRECTORY_REQUIRED');
 await mkdir(dir,{recursive:true,mode:0o700});
 // Exclusive local lock, distinct per mode. No silent lock takeover; a crashed runner needs operator review.
 const lockPath=join(dir,`${mode}.lock`),lock=await open(lockPath,"wx",0o600);
 try {
  if(mode==="observe"){
   const configPath=process.env.MONITORING_WINDOW_FILE;
   if(!configPath||(await stat(configPath)).size>8192)throw Error("MONITORING_WINDOW_REQUIRED");
   const policy=windowPolicy(JSON.parse(await readFile(configPath,"utf8")));if(!policy)throw Error("MONITORING_WINDOW_REQUIRED");
   const hash=policyHash(policy),history=join(dir,"window-history.json");
   let changes:{hash:string;at:string;policy:typeof policy}[]=[];
   try{if((await stat(history)).size<65536)changes=JSON.parse(await readFile(history,"utf8"));}catch{}
   if(changes.at(-1)?.hash!==hash){changes.push({hash,at:new Date().toISOString(),policy});await writeFile(history,JSON.stringify(changes.slice(-100)),{mode:0o600});}
   if(!expectedOnline(policy)){console.log("MONITORING_OUTSIDE_APPROVED_WINDOW");return;}
   const event=await observeApplication(process.env.MONITORING_APP_ORIGIN||"");
   await appendSafeLog(dir,event);
   const statePath=join(dir,"observer-state.json");let previous=null;
   try{if((await stat(statePath)).size<8192)previous=readObserverState(JSON.parse(await readFile(statePath,"utf8")));}catch{}
   const state=transition(previous,event,Date.now(),policy.notificationWindowSeconds);
   if(state.pending&&state.attempts<5&&state.nextAt<=Date.now()&&process.env.MONITORING_EXTERNAL_ENABLED==="true"){
    const delivered=await deliverTechnical(process.env.MONITORING_EXTERNAL_ENDPOINT,process.env.MONITORING_EXTERNAL_TOKEN,env,state.pending);
    state.lastDeliveryAt=Date.now();state.attempts++;state.nextAt=state.lastDeliveryAt+Math.max(policy.notificationWindowSeconds*1000,Math.min(3600000,30000*2**state.attempts));if(delivered)state.pending=null;
   }
   await writeFile(statePath,JSON.stringify(state),{mode:0o600});
   console.log(JSON.stringify({component:"app",code:event.code,deliveryPending:!!state.pending,attempts:state.attempts}));
   if(event.code!=="OK")process.exitCode=1;
   return;
  }
  const client=monitoringClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.MONITORING_SERVICE_KEY);
  const probe=await probeDependencies({url:process.env.NEXT_PUBLIC_SUPABASE_URL,key:process.env.MONITORING_SERVICE_KEY,bucket:process.env.MONITORING_STORAGE_BUCKET,object:process.env.MONITORING_STORAGE_OBJECT,sha256:process.env.MONITORING_STORAGE_SHA256});
  const observations:Observation[]=[...probe.checks];
  if(process.env.MONITORING_APP_ORIGIN)observations.push(await observeApplication(process.env.MONITORING_APP_ORIGIN));
  try{
   const facts=await client.rpc("system_health_jobs") as Record<string,JobFacts>;
   for(const component of ["drive","ocr","telegram"] as const){
    const code=jobCode(facts[component],configuredJobPolicy(component,process.env));
    observations.push({component,code,observedAt:new Date().toISOString(),correlation:randomUUID()});
   }
  }catch{for(const component of ["drive","ocr","telegram"] as const)observations.push({component,code:"UNAVAILABLE",observedAt:new Date().toISOString(),correlation:randomUUID()});}
  let backup=null;
  try{const file=process.env.MONITORING_BACKUP_MANIFEST;if(file&&(await stat(file)).size<=8192)backup=verifyBackup(await readFile(file,"utf8"),process.env.MONITORING_BACKUP_PUBLIC_KEY||"",env);}catch{}
  observations.push({component:"backup",code:!backup?"UNVERIFIED":Date.now()-Date.parse(backup.copiedAt)>86400000?"STALE":backup.restorePassed?"OK":"UNVERIFIED",observedAt:new Date().toISOString(),correlation:randomUUID()});
  for(const event of observations){await appendSafeLog(dir,event);if(!await recordObservation(client,env,event))process.exitCode=1;}
  if(process.env.MONITORING_EXTERNAL_ENABLED==="true"){
   const claimed=await client.rpc("claim_system_health_delivery",{p_environment:env}) as {id:string;claim:string;component:Observation["component"];code:Observation["code"];observedAt:string;correlation:string}|null;
   if(claimed){const event={...claimed,observedAt:new Date(claimed.observedAt).toISOString()};const ok=await deliverTechnical(process.env.MONITORING_EXTERNAL_ENDPOINT,process.env.MONITORING_EXTERNAL_TOKEN,env,event);await client.rpc("finish_system_health_delivery",{p_id:claimed.id,p_claim:claimed.claim,p_success:ok});if(!ok)process.exitCode=1;}
  }
  console.log(JSON.stringify(observations.map(({component,code})=>({component,code}))));
 }finally{await lock.close();await unlink(lockPath);}
}
main().catch(()=>{console.error("MONITORING_FAILED_OR_NOT_CONFIGURED");process.exitCode=1;});
