// Test process only. No credentials/providers configured; every attempted external fetch is evidence of failure.
import {appendFileSync} from 'node:fs';
const original=globalThis.fetch;
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url??input.toString());
  if(['127.0.0.1','localhost'].includes(url.hostname)&&['54321','3100'].includes(url.port))return original(input,init);
  appendFileSync(process.env.NEXUS_RECOVERY_NETWORK_LOG,JSON.stringify({blocked:true,protocol:url.protocol})+'\n');
  throw new Error('Recovery rehearsal blocks external network');
};
