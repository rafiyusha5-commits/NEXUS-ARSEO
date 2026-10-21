import {test} from 'node:test';
import assert from 'node:assert/strict';
import {startFaultHttp} from './fault-http.mjs';
import {makeExternalFixtures} from './external-fixtures.mjs';

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
