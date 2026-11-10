import { randomUUID, createHash } from "node:crypto";
import { failures, safeObservation, type Code, type Observation, type Environment } from "./policy.ts";

export type WindowPolicy = { timeZone: string; weekdays: number[]; startHour: number; endHour: number; maintenanceUntil: string | null; reason: string };
export function windowPolicy(value: unknown): WindowPolicy | null {
  if (!value || typeof value !== "object") return null;
  const p = value as WindowPolicy;
  if (p.timeZone !== "Asia/Almaty" && p.timeZone !== "UTC") return null;
  if (!Array.isArray(p.weekdays) || !p.weekdays.length || p.weekdays.some(n => !Number.isInteger(n) || n<0 || n>6)) return null;
  if (!Number.isInteger(p.startHour) || !Number.isInteger(p.endHour) || p.startHour<0 || p.endHour>24 || p.startHour>=p.endHour) return null;
  if (typeof p.reason!=="string" || !p.reason.trim() || p.reason.length>500) return null;
  if (p.maintenanceUntil!==null && (typeof p.maintenanceUntil!=="string" || !Number.isFinite(Date.parse(p.maintenanceUntil)))) return null;
  return { timeZone:p.timeZone,weekdays:p.weekdays,startHour:p.startHour,endHour:p.endHour,maintenanceUntil:p.maintenanceUntil,reason:p.reason };
}
export function expectedOnline(policy: WindowPolicy, now = new Date()): boolean {
  if (policy.maintenanceUntil && Date.parse(policy.maintenanceUntil)>now.getTime()) return false;
  const parts = new Intl.DateTimeFormat("en-US",{timeZone:policy.timeZone,weekday:"short",hour:"numeric",hourCycle:"h23"}).formatToParts(now);
  const day=["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(parts.find(p=>p.type==="weekday")!.value);
  const hour=Number(parts.find(p=>p.type==="hour")!.value);
  return policy.weekdays.includes(day) && hour>=policy.startHour && hour<policy.endHour;
}
export const policyHash = (policy: WindowPolicy) => createHash("sha256").update(JSON.stringify(policy)).digest("hex");
export async function observeApplication(origin: string, request: typeof fetch=fetch, timeoutMs=4000): Promise<Observation> {
  let code: Code="UNAVAILABLE";
  const controller=new AbortController(); let timer: ReturnType<typeof setTimeout>|undefined;
  try {
    const url=new URL(origin);
    if (url.username || url.password || url.search || url.hash || url.pathname!=="/" || (url.protocol!=="https:" && !(url.protocol==="http:" && ["127.0.0.1","localhost"].includes(url.hostname)))) throw Error();
    const work=(async()=>{ const r=await request(new URL("/api/health/live",url),{signal:controller.signal,redirect:"error",cache:"no-store"});
      if (!r.ok) { await r.body?.cancel(); return "UNAVAILABLE" as Code; }
      const reader=r.body?.getReader();if(!reader)return "UNAVAILABLE" as Code;
      let text="";try{for(;;){const part=await reader.read();if(part.done)break;text+=Buffer.from(part.value).toString();if(text.length>128)return "UNAVAILABLE" as Code;}}finally{await reader.cancel().catch(()=>{});}
      const p=JSON.parse(text);return p?.status==="ok"?"OK" as Code:"UNAVAILABLE" as Code;
    })().catch(()=>controller.signal.aborted?"TIMEOUT" as Code:"UNAVAILABLE" as Code);
    code=await Promise.race([work,new Promise<Code>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve("TIMEOUT");},Math.min(4000,Math.max(10,timeoutMs)));})]);
  } catch { /* Fixed vocabulary only. */ } finally { clearTimeout(timer);controller.abort(); }
  return {component:"app",code,observedAt:new Date().toISOString(),correlation:randomUUID()};
}
export type ObserverState = { lastCode: Code; pending: Observation | null; attempts: number; nextAt: number };
export function transition(previous: ObserverState | null, observation: Observation, now=Date.now()): ObserverState {
  const changed = !previous || previous.lastCode!==observation.code;
  // First healthy check does not announce recovery. Failed delivery is retained for bounded retry.
  if (changed && (failures.has(observation.code) || observation.code==="OK" && previous && failures.has(previous.lastCode)))
    return {lastCode:observation.code,pending:observation,attempts:0,nextAt:now};
  return previous ? {...previous,lastCode:observation.code} : {lastCode:observation.code,pending:null,attempts:0,nextAt:now};
}
export function readObserverState(input: unknown): ObserverState | null {
  if(!input||typeof input!=="object")return null;
  const p=input as ObserverState;
  if(!["OK","UNAVAILABLE","TIMEOUT"].includes(p.lastCode)||!Number.isInteger(p.attempts)||p.attempts<0||p.attempts>5||!Number.isFinite(p.nextAt))return null;
  const pending=p.pending===null?null:safeObservation(p.pending);
  if(p.pending!==null&&!pending)return null;
  return {lastCode:p.lastCode,pending,attempts:p.attempts,nextAt:p.nextAt};
}
// Explicit opt-in endpoint owned by the deployment operator; never a document/user supplied URL.
// The receiver deduplicates Idempotency-Key. No Telegram/chat/business identifiers are sent.
export async function deliverTechnical(endpoint: string | undefined, token: string | undefined, env: Environment, observation: Observation, request: typeof fetch=fetch): Promise<boolean> {
  const event=safeObservation(observation);
  if(!endpoint||!token||!event)return false;
  const controller=new AbortController(); let timer: ReturnType<typeof setTimeout>|undefined;
  try {
    const url=new URL(endpoint);if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)return false;
    const work=request(url,{method:"POST",redirect:"error",signal:controller.signal,headers:{"Content-Type":"application/json",Authorization:`Bearer ${token}`,"Idempotency-Key":`${env}:${event.correlation}:${event.code}`},body:JSON.stringify({environment:env,...event})})
      .then(async r=>{await r.body?.cancel();return r.ok;}).catch(()=>false);
    return await Promise.race([work,new Promise<boolean>(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(false);},3000);})]);
  }catch{return false;}finally{clearTimeout(timer);controller.abort();}
}
