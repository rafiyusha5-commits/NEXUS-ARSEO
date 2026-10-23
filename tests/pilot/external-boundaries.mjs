// Loaded ONLY by the disposable E2E server. Real auth, REST, Storage and SQL remain intact.
import fs from 'node:fs';
import crypto from 'node:crypto';
const fixture=JSON.parse(fs.readFileSync(process.env.NEXUS_SYNTHETIC_FIXTURES,'utf8'));
const original=globalThis.fetch;
const log=data=>fs.appendFileSync(process.env.NEXUS_SYNTHETIC_REQUESTS,JSON.stringify(data)+'\n');
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
globalThis.fetch=async(input,init)=>{
  const url=new URL(typeof input==='string'?input:input.url??input.toString());
  const method=(init?.method??input.method??'GET').toUpperCase();
  // Next follows its own server-action redirects with a local fetch.
  if(['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='3100')return original(input,init);
  if(process.env.NEXUS_FAULT_HTTP){
    const endpoint=new URL(process.env.NEXUS_FAULT_HTTP);
    if(endpoint.hostname!=='127.0.0.1'||endpoint.protocol!=='http:')throw new Error('Fault endpoint must be loopback');
    const backend=['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='54321';
    const drive=url.origin==='https://www.googleapis.com'&&url.pathname.startsWith('/drive/v3/files')&&method==='GET';
    const ocr=url.origin==='https://synthetic-ocr.invalid'&&method==='POST';
    const oauth=url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/token'&&method==='POST';
    if(!(backend||drive||ocr||oauth))throw new Error('E2E external network blocked: '+url.origin);
    if(drive)log({kind:'drive',method,id:url.pathname.split('/').at(-1),media:url.searchParams.get('alt')==='media'});
    const signal=init?.signal??(input instanceof Request?input.signal:undefined);
    if(ocr){log({kind:'ocr',method,hasAbortSignal:!!signal});signal?.addEventListener('abort',()=>log({kind:'ocr-abort'}),{once:true});}
    endpoint.searchParams.set('target',url.href);
    const request=new Request(input,init);
    return original(endpoint,{method,headers:request.headers,body:['GET','HEAD'].includes(method)?undefined:await request.arrayBuffer(),signal,redirect:'error'});
  }
  if(['127.0.0.1','localhost'].includes(url.hostname)&&['54321','3100'].includes(url.port))return original(input,init);
  if(url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/token'&&method==='POST'){
    log({kind:'oauth',method});return json({access_token:'synthetic-read-only',expires_in:3600});
  }
  if(url.origin==='https://www.googleapis.com'&&url.pathname.startsWith('/drive/v3/files')){
    if(method!=='GET')throw new Error('Synthetic Drive rejects every write');
    const id=url.pathname.split('/').at(-1),media=url.searchParams.get('alt')==='media';
    log({kind:'drive',method,id,media});
    if(id==='files')return json({files:fixture.files.map(f=>Object.fromEntries(Object.entries(f).filter(([k])=>!['base64','text','sha256','key'].includes(k))))});
    if([fixture.root,fixture.folder].includes(id))return json({id,name:'Synthetic folder',mimeType:'application/vnd.google-apps.folder',parents:id===fixture.root?[]:[fixture.root],trashed:false});
    const file=fixture.files.find(f=>f.id===id);if(!file)return new Response('',{status:404});
    return media?new Response(Buffer.from(file.base64,'base64'),{headers:{'content-type':file.mimeType}}):json({...file,trashed:false});
  }
  if(url.origin==='https://synthetic-ocr.invalid'&&method==='POST'){
    const body=JSON.parse(init.body),hash=crypto.createHash('sha256').update(Buffer.from(body.content_base64,'base64')).digest('hex');
    const file=fixture.files.find(f=>f.sha256===hash);if(!file)throw new Error('Unknown synthetic OCR bytes');
    log({kind:'ocr',method,file:file.key});
    await new Promise(resolve=>setTimeout(resolve,400));
    return json({text:file.text,pages:1,confidence:0.99});
  }
  throw new Error('E2E external network blocked: '+url.origin);
};
