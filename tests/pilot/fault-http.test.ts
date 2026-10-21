import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startFaultHttp} from './fault-http.mjs';
import {makeExternalFixtures} from './external-fixtures.mjs';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,unlinkSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('fault HTTP uses real sockets, rejects external targets and all Drive writes',async()=>{
  const fixtures=makeExternalFixtures(),server=await startFaultHttp(fixtures);
  const call=(target:string,init?:RequestInit)=>fetch(server.endpoint+'/?target='+encodeURIComponent(target),init);
  try{
    const response=await call(`https://www.googleapis.com/drive/v3/files/${fixtures.files[0].id}?alt=media`);
    assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),Buffer.from(fixtures.files[0].base64,'base64'));
    assert.equal((await call('https://example.invalid/')).status,500);
    assert.equal((await call(`https://www.googleapis.com/drive/v3/files/${fixtures.files[0].id}`,{method:'DELETE'})).status,500);
  }finally{await server.close();}
});

test('application boundary forwards the original abort signal through real HTTP',async()=>{
  const fixtures=makeExternalFixtures(),server=await startFaultHttp(fixtures),dir=mkdtempSync(join(tmpdir(),'nexus-fault-signal-'));
  const fixturePath=join(dir,'fixtures.json'),logPath=join(dir,'requests.jsonl');writeFileSync(fixturePath,JSON.stringify(fixtures));
  const script=`import assert from 'node:assert/strict';
    const c=new AbortController();setTimeout(()=>c.abort(),500);
    await assert.rejects(fetch('https://synthetic-ocr.invalid/recognize',{method:'POST',signal:c.signal,body:JSON.stringify({content_base64:${JSON.stringify(fixtures.files[0].base64)}})}),/abort/i);`;
  const gate=server.arm('ocr','hold',fixtures.files[0].id);
  const child=spawn(process.execPath,['--import',new URL('./external-boundaries.mjs',import.meta.url).href,'--input-type=module','-e',script],{
    env:{NODE_ENV:'test',NEXUS_SYNTHETIC_FIXTURES:fixturePath,NEXUS_SYNTHETIC_REQUESTS:logPath,NEXUS_FAULT_HTTP:server.endpoint},windowsHide:true,stdio:['ignore','ignore','pipe']});
  let stderr='';child.stderr.on('data',b=>{stderr+=b;});
  const timer=setTimeout(()=>child.kill(),8000);
  try{
    const code=await new Promise(r=>child.once('exit',r));assert.equal(code,0,stderr);await gate.wait();
    assert.ok(readFileSync(logPath,'utf8').includes('ocr-abort'));
  }finally{clearTimeout(timer);gate.release(true);await server.close();for(const p of [fixturePath,logPath])try{unlinkSync(p);}catch{}rmdirSync(dir);}
});

test('fault barrier proves request arrival and observes source changes before responding',async()=>{
  const fixtures=makeExternalFixtures(),server=await startFaultHttp(fixtures);
  try{
    const file=fixtures.files[0],gate=server.arm('drive-metadata','hold',file.id);
    const pending=fetch(server.endpoint+'/?target='+encodeURIComponent('https://www.googleapis.com/drive/v3/files/'+file.id));
    await gate.wait();file.version='2';gate.release();assert.equal((await (await pending).json()).version,'2');
  }finally{await server.close();}
});

test('fault HTTP preserves abort semantics and a failed request does not poison its retry',async()=>{
  const fixtures=makeExternalFixtures(),server=await startFaultHttp(fixtures);
  try{
    const file=fixtures.files[0],gate=server.arm('ocr','hold',file.id);
    const url=server.endpoint+'/?target='+encodeURIComponent('https://synthetic-ocr.invalid/recognize');
    const controller=new AbortController();
    const pending=fetch(url,{method:'POST',body:JSON.stringify({content_base64:file.base64}),signal:controller.signal});
    const rejected=assert.rejects(pending,/abort/i);await gate.wait();controller.abort();await rejected;gate.release(true);
    const r=await fetch(url,{method:'POST',body:JSON.stringify({content_base64:file.base64})});
    assert.equal((await r.json()).text,file.text);
    const failure=server.arm('ocr','fail-before',file.id);
    assert.equal((await fetch(url,{method:'POST',body:JSON.stringify({content_base64:file.base64})})).status,503);await failure.wait();
  }finally{await server.close();}
});
