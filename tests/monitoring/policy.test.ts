import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID,generateKeyPairSync,sign} from "node:crypto";
import {mkdtemp,readFile,writeFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {safeObservation,jobCode,type JobFacts} from "../../src/lib/monitoring/policy.ts";
import {probeDependencies,cachedProbe} from "../../src/lib/monitoring/probes.ts";
import {verifyBackup} from "../../src/lib/monitoring/backup.ts";
import {appendSafeLog} from "../../src/lib/monitoring/local-log.ts";
import {observeApplication,deliverTechnical,transition,windowPolicy,expectedOnline,readObserverState} from "../../src/lib/monitoring/observer.ts";
import {monitoringClient} from "../../src/lib/monitoring/client.ts";
const event=()=>({component:"app" as const,code:"FAILED" as const,observedAt:new Date().toISOString(),correlation:randomUUID()});
const config={url:"https://synthetic.invalid",key:"synthetic-key",bucket:"health",object:"canary.txt",sha256:createHash("sha256").update("nexus-canary").digest("hex")};
const healthy:typeof fetch=async input=>new Response(String(input).includes("system_health_ping")?"true":"nexus-canary");
test("readiness reads database and exact canary bytes, not success headers",async()=>{
 assert.equal((await probeDependencies(config,healthy)).ready,true);
 const bad=await probeDependencies(config,async()=>new Response("wrong"));assert.equal(bad.ready,false);assert.ok(bad.checks.every(c=>c.code==="UNAVAILABLE"));
 const huge=await probeDependencies(config,async()=>new Response("x".repeat(4097)));assert.equal(huge.ready,false);
 assert.equal((await probeDependencies({},healthy)).checks[0].code,"NOT_CONFIGURED");
});
test("a hung body cannot consume the whole request indefinitely; finished checks retain their status",async()=>{
 const started=Date.now();let aborted=false;
 const fetcher:typeof fetch=async(input,options)=>{
  options?.signal?.addEventListener("abort",()=>{aborted=true;});
  if(String(input).includes("system_health_ping"))return new Response("true");
  return new Response(new ReadableStream({start(){ /* never ends */ }}));
 };
 const r=await probeDependencies(config,fetcher,40);
 assert.ok(Date.now()-started<1000);assert.ok(aborted);assert.equal(r.checks[0].code,"OK");assert.equal(r.checks[1].code,"TIMEOUT");
});
test("parallel public probes share a single flight and cooldown",async()=>{
 let calls=0;let now=1;const run=cachedProbe(async()=>{calls++;await new Promise(r=>setTimeout(r,10));return probeDependencies(config,healthy);},()=>now);
 await Promise.all(Array.from({length:100},()=>run()));assert.equal(calls,1);await run();assert.equal(calls,1);now=6000;await run();assert.equal(calls,2);
});
test("job classifications distinguish disabled, manual, stale scheduled heartbeat and unresolved work",()=>{
 const empty:JobFacts={queued:0,running:0,retry:0,needsAction:0,failed:0,expired:0,lastAttempt:null,lastSuccess:null};
 const manual={mode:"manual" as const,intervalSeconds:60,graceSeconds:120};
 assert.equal(jobCode(empty,manual),"MANUAL");assert.equal(jobCode(empty,{...manual,mode:"scheduled"}),"UNVERIFIED");
 assert.equal(jobCode({...empty,expired:1},{...manual,mode:"disabled"}),"DISABLED");
 assert.equal(jobCode({...empty,expired:1},manual),"NEEDS_ACTION");assert.equal(jobCode({...empty,retry:1},manual),"RETRY");
 assert.equal(jobCode({...empty,running:1},manual),"RUNNING");
 const past=new Date(Date.now()-3600000).toISOString();assert.equal(jobCode({...empty,lastAttempt:past,lastSuccess:past},{...manual,mode:"scheduled"}),"STALE");
 assert.equal(jobCode({...empty,lastAttempt:past,lastSuccess:past},manual),"OK");
});
test("only an authentic environment-bound backup report can prove restore",()=>{
 const keys=generateKeyPairSync("ed25519"),pub=keys.publicKey.export({format:"pem",type:"spki"}).toString();
 const date=new Date(Date.now()-60000).toISOString();const payload={environment:"test",copiedAt:date,integrityAt:date,restoredAt:date,restorePassed:true,archiveSha256:"a".repeat(64)};
 const encode=(p:unknown)=>{const text=JSON.stringify(p);return JSON.stringify({payload:text,signature:sign(null,Buffer.from(text),keys.privateKey).toString("base64")});};
 assert.ok(verifyBackup(encode(payload),pub,"test"));assert.equal(verifyBackup(encode(payload),pub,"production"),null);
 assert.equal(verifyBackup(encode({...payload,restoredAt:null}),pub,"test"),null);
 assert.equal(verifyBackup(encode({...payload,integrityAt:null}),pub,"test"),null);
 assert.equal(verifyBackup(encode({...payload,restorePassed:"true"}),pub,"test"),null);
 assert.equal(verifyBackup(encode(payload).replace('a'.repeat(64),'b'.repeat(64)),pub,"test"),null);
 assert.equal(verifyBackup(encode({...payload,copiedAt:"2099-01-01T00:00:00.000Z"}),pub,"test"),null);
 assert.equal(verifyBackup(encode({...payload,rawError:"Bearer secret"}),pub,"test"),null);
 const copy=verifyBackup(encode({...payload,integrityAt:null,restoredAt:null,restorePassed:false}),pub,"test");assert.equal(copy?.restorePassed,false);
});
test("logs allowlist fields; rotation, restart bounds and unavailable disk are nonfatal",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"nexus-health-unit-"));
 const source={...event(),error:"Bearer secret@example.invalid",sql:"select password",url:"?token=secret",request:{body:"personal data"}};
 assert.deepEqual(Object.keys(safeObservation(source)!).sort(),["code","component","correlation","observedAt"]);
 assert.equal(await appendSafeLog(dir,source),true);
 const file=join(dir,`health-${process.pid}.jsonl`);assert.ok(!(await readFile(file,"utf8")).includes("secret"));
 await writeFile(file,"x".repeat(65536));await appendSafeLog(dir,event());assert.ok((await readdir(dir)).includes(`health-${process.pid}.jsonl.1`));
 for(let i=1;i<15;i++)await writeFile(join(dir,`health-${i}.jsonl`),"safe\n");await appendSafeLog(dir,event());assert.ok((await readdir(dir)).length<=12);
 assert.equal(await appendSafeLog(file,event()),false);assert.equal(await appendSafeLog(join(process.cwd(),"public","bad"),event()),false);
 assert.equal(await appendSafeLog(dir,{...source,code:"query with private values"}),false);
});
test("external independent observer detects a stopped application without database access",async()=>{
 const stopped=await observeApplication("http://localhost:39999",async()=>{throw Error("secret refusal");});assert.equal(stopped.code,"UNAVAILABLE");
 const healthy=await observeApplication("https://synthetic.invalid",async()=>new Response('{"status":"ok"}'));assert.equal(healthy.code,"OK");
 const hung=await observeApplication("https://synthetic.invalid",()=>new Promise(()=>{}),30);assert.equal(hung.code,"TIMEOUT");
 assert.equal((await observeApplication("https://user:password@synthetic.invalid",async()=>new Response('{"status":"ok"}'))).code,"UNAVAILABLE");
});
test("external channel failures retain one retryable incident, with no recursive failure messages",async()=>{
 const e={...event(),code:"UNAVAILABLE" as const};let state=transition(null,e,1000);const first=state.pending!.correlation;
 for(let i=0;i<100;i++)state=transition(state,{...e,correlation:randomUUID()},1000+i);
 assert.equal(state.pending!.correlation,first);
 const recovered=transition(state,{...e,code:"OK",correlation:randomUUID()});assert.equal(recovered.pending?.code,"OK");
 assert.equal(transition(null,{...e,code:"OK"}).pending,null);
 assert.equal(readObserverState({...state,attempts:99}),null);
 let payload="";const fail:typeof fetch=async(_,options)=>{payload=String(options?.body);return new Response("secret",{status:503});};
 assert.equal(await deliverTechnical("https://synthetic.invalid/hook","token","test",{...e,raw:"secret"} as typeof e,fail),false);
 assert.ok(!payload.includes("secret"));assert.ok(payload.includes('"environment":"test"'));
 assert.equal(await deliverTechnical("http://synthetic.invalid","token","test",e,fail),false);
});
test("work hours and explicit maintenance are respected in Kazakhstan time",()=>{
 const policy=windowPolicy({timeZone:"Asia/Almaty",weekdays:[1,2,3,4,5],startHour:9,endHour:18,maintenanceUntil:null,reason:"Approved test window"})!;
 assert.ok(policy);assert.equal(expectedOnline(policy,new Date("2026-11-10T06:00:00Z")),true);
 assert.equal(expectedOnline(policy,new Date("2026-11-10T16:00:00Z")),false);
 assert.equal(expectedOnline({...policy,maintenanceUntil:"2026-11-10T12:00:00Z"},new Date("2026-11-10T06:00:00Z")),false);
 assert.equal(windowPolicy({...policy,reason:""}),null);
});
test("monitoring client cannot call arbitrary business RPCs or leak their errors",async()=>{
 let calls=0;const c=monitoringClient("https://synthetic.invalid","key",async()=>{calls++;return new Response("password / SQL / document",{status:500});});
 await assert.rejects(c.rpc("receive_shipment_transport"),/MONITORING_UNAVAILABLE/);assert.equal(calls,0);
 await assert.rejects(c.rpc("system_health_jobs"),/^Error: MONITORING_UNAVAILABLE$/);assert.equal(calls,1);
});
