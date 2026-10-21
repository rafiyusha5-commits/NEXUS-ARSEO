// Test-only loopback HTTP boundary. Auth, PostgREST and Storage still execute in
// the disposable Supabase instance; only explicitly armed transport failures intervene.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';

export async function startFaultHttp(fixtures) {
  const rules=[], events=[];
  const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}});
  const server=createServer(async(req,res)=>{
    try {
      const url=new URL(new URL(req.url,'http://127.0.0.1').searchParams.get('target'));
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const bytes=Buffer.concat(chunks), method=req.method;
      const local=['127.0.0.1','localhost'].includes(url.hostname)&&url.port==='54321';
      const google=url.origin==='https://www.googleapis.com'&&url.pathname.startsWith('/drive/v3/files');
      const ocr=url.origin==='https://synthetic-ocr.invalid'&&method==='POST';
      const oauth=url.origin==='https://oauth2.googleapis.com'&&url.pathname==='/token'&&method==='POST';
      assert.ok(local||google||ocr||oauth,'External network blocked');
      if(google)assert.equal(method,'GET','Drive writes are forbidden');
      const id=url.pathname.split('/').at(-1), media=url.searchParams.get('alt')==='media';
      const file=ocr?fixtures.files.find(f=>f.sha256===createHash('sha256').update(Buffer.from(JSON.parse(bytes).content_base64,'base64')).digest('hex')):fixtures.files.find(f=>f.id===id);
      const kind=ocr?'ocr':google?(media?'drive-media':'drive-metadata'):oauth?'oauth':
        url.pathname.includes('/storage/v1/object/')&&method==='POST'?'storage-upload':
        url.pathname.endsWith('/rpc/import_shipment_drive_file')?'import-rpc':'backend';
      // Never log headers, tokens, request bodies or database responses.
      const event={kind,id:file?.id??(google?id:undefined),method};events.push(event);
      const rule=rules.find(r=>!r.used&&r.kind===kind&&(!r.id||r.id===event.id));
      if(rule){rule.used=true;rule.seen(event);}
      const fail=()=>new Response(JSON.stringify({message:'Synthetic transport failure',code:'FAULT_HTTP'}),{status:503,headers:{'content-type':'application/json'}});
      async function execute(){
        if(local){
          const headers=new Headers(req.headers);headers.delete('host');headers.delete('connection');headers.delete('content-length');headers.delete('accept-encoding');
          return fetch(url,{method,headers,body:['GET','HEAD'].includes(method)?undefined:bytes,redirect:'error'});
        }
        if(oauth)return json({access_token:'synthetic-read-only',expires_in:3600});
        if(ocr){assert.ok(file,'Unknown OCR bytes');await new Promise(r=>setTimeout(r,400));return json({text:file.text,pages:1,confidence:0.99});}
        if(id==='files')return json({files:fixtures.files.map(f=>Object.fromEntries(Object.entries(f).filter(([k])=>!['base64','text','sha256','key'].includes(k))))});
        if([fixtures.root,fixtures.folder].includes(id))return json({id,name:'Synthetic folder',mimeType:'application/vnd.google-apps.folder',parents:id===fixtures.root?[]:[fixtures.root],trashed:false});
        if(!file)return new Response('',{status:404});
        return media?new Response(Buffer.from(file.base64,'base64'),{headers:{'content-type':file.mimeType}}):json({...file,trashed:false});
      }
      let response;
      if(rule?.mode==='fail-before')response=fail();
      else {
        if(rule?.mode==='hold'){
          // A barrier is bounded even if the test or the application dies.
          let timer;
          try{await Promise.race([rule.released,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Unreleased fault barrier')),120000);})]);}
          finally{clearTimeout(timer);}
          if(rule.drop)response=fail();
        }
        response??=await execute();
        if(rule?.mode==='fail-after') {await response.arrayBuffer();response=fail();}
      }
      const body=Buffer.from(await response.arrayBuffer());
      // Fetch may decompress a forwarded response; don't forward its old encoding/length.
      const headers=Object.fromEntries(response.headers);delete headers['content-encoding'];delete headers['content-length'];delete headers['transfer-encoding'];
      res.writeHead(response.status,headers);res.end(body);
    } catch(error){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({message:'Fault harness error'}));console.error('FAULT HTTP:',error.message);}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {
    endpoint:`http://127.0.0.1:${server.address().port}`,events,
    arm(kind,mode='hold',id){
      let seen,release;
      const observed=new Promise(r=>{seen=r;});const released=new Promise(r=>{release=r;});
      const rule={kind,mode,id,seen,released,release,used:false,drop:false};rules.push(rule);
      return {async wait(){let t;try{return await Promise.race([observed,new Promise((_,j)=>{t=setTimeout(()=>j(new Error(`Fault not reached: ${kind}`)),25000);})]);}finally{clearTimeout(t);}},release(drop=false){rule.drop=drop;release();},get used(){return rule.used;}};
    },
    async close(){for(const r of rules){r.drop=true;r.release();}server.closeAllConnections();await new Promise(r=>server.close(r));},
  };
}
