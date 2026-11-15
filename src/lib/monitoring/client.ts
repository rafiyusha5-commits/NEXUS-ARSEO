import { safeObservation, type Environment, type Observation } from "./policy.ts";
export type MonitoringClient = { rpc: (name: string, args?: Record<string, unknown>) => Promise<unknown> };
const methods=new Set(["record_system_health","system_health_jobs","claim_system_health_delivery","finish_system_health_delivery"]);
export function monitoringClient(origin: string | undefined,key: string | undefined, request: typeof fetch=fetch): MonitoringClient {
  return {async rpc(name,args={}) {
    if(!origin||!key||!methods.has(name))throw new Error("MONITORING_UNAVAILABLE");
    const url=new URL(origin);
    if(url.username||url.password||(url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname))))throw new Error("MONITORING_UNAVAILABLE");
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const work=(async()=>{
        const r=await request(new URL(`/rest/v1/rpc/${name}`,url),{method:"POST",redirect:"error",signal:controller.signal,headers:{apikey:key,Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(args)});
        if(!r.ok){await r.body?.cancel();throw Error();}
        const reader=r.body?.getReader();if(!reader)throw Error();let size=0;const chunks:Uint8Array[]=[];
        try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.length;if(size>65536)throw Error();chunks.push(p.value);}}finally{await reader.cancel().catch(()=>{});}
        return JSON.parse(Buffer.concat(chunks).toString());
      })();
      return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error());},4000);})]);
    }catch{throw new Error("MONITORING_UNAVAILABLE");}finally{clearTimeout(timer);controller.abort();}
  }};
}
export async function recordObservation(client: MonitoringClient, env: Environment, input: Observation): Promise<boolean> {
  const e=safeObservation(input);if(!e)return false;
  try {await client.rpc("record_system_health",{p_environment:env,p_component:e.component,p_code:e.code,p_observed_at:e.observedAt,p_correlation:e.correlation});return true;}catch{return false;}
}
