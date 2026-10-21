// Supplementary PostgreSQL fault tests. Not an Auth/Storage/HTTP or full app restart test.
// Invoked by test:db against its disposable cluster, never a deployed database.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
const [command,...args]=process.argv.slice(2);
assert.ok(command,'Pass psql and disposable database arguments');
const host=args[args.indexOf('-h')+1];
assert.ok(args.includes('-h') && (host==='127.0.0.1'||host==='localhost'||host.startsWith('/')),'Only local test PostgreSQL');
function start(sql){
  const child=spawn(command,[...args,'-X','-q','-tA','-v','ON_ERROR_STOP=1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';
  child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>child.kill(),45000);
  const result=new Promise((resolve,reject)=>{
    child.on('error',error=>{clearTimeout(timer);reject(error)});
    child.on('close',code=>{clearTimeout(timer);resolve({code,stdout:stdout.trim(),stderr})});
  });
  child.stdin.end("set statement_timeout='40s';\n"+sql);
  return {child,result};
}
async function run(sql){const r=await start(sql).result;assert.equal(r.code,0,r.stderr);return r.stdout;}
const user='f7000000-0000-4000-8000-000000000001';
const shipment='f7300000-0000-4000-8000-000000000001';
const extraction='f7603000-0000-4000-8000-000000000001';
const who=`set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`;
const claim=`public.begin_shipment_source_ocr('${shipment}','f7503000-0000-4000-8000-000000000001','f7513000-0000-4000-8000-000000000001','invoice',repeat('a',64),'synthetic','v1',3,60,false)`;
const json=async sql=>JSON.parse((await run(sql)).split('\n').findLast(line=>line.startsWith('JSON:')).slice(5));
const begin=()=>json(`${who} select 'JSON:'||${claim}::text;`);
const row=()=>json(`select 'JSON:'||to_jsonb(e)::text from public.shipment_source_extractions e where id='${extraction}';`);
const finish=(lease,status='extracted',data={invoice_number:'NEW'})=>`${who} select public.finish_shipment_source_ocr_fenced('${extraction}','${lease}','${status}','${JSON.stringify(data)}');`;
const expire=()=>run(`update public.shipment_source_extractions set processing_started_at=clock_timestamp()-interval '2 minutes' where id='${extraction}';`);
async function rejected(sql){const r=await start(sql).result;assert.notEqual(r.code,0,'Expected refusal');}
const fixture=(await readFile(new URL('../supabase/tests/fixtures/source_integrity.sql',import.meta.url),'utf8')).replaceAll('eb','f7').replaceAll('DQ','OCR-FAULT').replaceAll('@test.local','@ocr-fault.invalid');
await run(fixture);
const business=()=>json(`select 'JSON:'||jsonb_build_object(
 'items',(select jsonb_agg(to_jsonb(i) order by id) from public.shipment_items i where shipment_id='${shipment}'),
 'documents',(select jsonb_agg(to_jsonb(d) order by id) from public.documents d where id::text like 'f750%'),
 'versions',(select jsonb_agg(to_jsonb(v) order by id) from public.document_versions v where document_id::text like 'f750%'),
 'links',(select jsonb_agg(to_jsonb(l) order by id) from public.document_links l where document_id::text like 'f750%'),
 'confirmed',(select jsonb_agg(to_jsonb(e) order by id) from public.shipment_source_extractions e where shipment_id='${shipment}' and id<>'${extraction}')
 )::text;`);
const original=await business();
const claims=await Promise.all(Array.from({length:10},()=>begin()));
assert.equal(claims.filter(c=>c.action==='run').length,1);
assert.equal(claims.filter(c=>c.action==='busy').length,9);
const old=claims.find(c=>c.action==='run');
console.log('PASS OCR: ten concurrent requests, exactly one lease');

await run(finish(old.lease_started_at,'failed',{}));
const retry=await begin();assert.equal(retry.action,'run');assert.equal(retry.attempt,2);
const pending=await row();await rejected(finish(old.lease_started_at));assert.deepEqual(await row(),pending);
console.log('PASS OCR: timeout/retry and late old attempt cannot overwrite new lease');

await expire();
const crashed=start(`${who} set application_name='nexus-ocr-fault-crash'; select 'JSON:'||${claim}::text; select pg_sleep(30);`);
try{
  let ready=false;
  for(let n=0;n<100;n++){
    ready=(await run("select exists(select 1 from pg_stat_activity where application_name='nexus-ocr-fault-crash' and wait_event='PgSleep');"))==='t';
    if(ready)break;await delay(20);
  }
  assert.ok(ready,'Worker committed its lease before being killed');
}finally{crashed.child.kill();await crashed.result;}
assert.equal((await row()).status,'pending');
assert.equal((await begin()).action,'busy','Death does not allow a second live lease');
await expire();const resumed=await begin();assert.equal(resumed.action,'run');
console.log('PASS OCR: killed SQL client, persisted lease and expiry recovery (not a Nexus restart)');

await run(`insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select '${user}',id,'deny','Synthetic revoke between claim and finish','${user}' from public.permissions where code='source_documents.ocr';`);
const revoked=await row();await rejected(finish(resumed.lease_started_at));assert.deepEqual(await row(),revoked);
await run(`delete from public.user_permission_overrides where user_id='${user}' and permission_id=(select id from public.permissions where code='source_documents.ocr');`);
console.log('PASS OCR: permission revoked after claim refuses completion without changing extraction');

await run(finish(resumed.lease_started_at));
const succeeded=await row();await rejected(finish(retry.lease_started_at));assert.deepEqual(await row(),succeeded);
await run(`${who} select public.review_shipment_source_extraction('${extraction}','{"invoice_number":"MANUAL-KEPT"}',false);`);
const reviewed=await row();assert.equal(reviewed.status,'confirmed');
await rejected(finish(resumed.lease_started_at,'failed',{}));
assert.equal((await begin()).action,'reuse');assert.deepEqual(await row(),reviewed);
assert.deepEqual(await business(),original,'No changes to other files, links, quantities or prior confirmations');
console.log('PASS OCR: late result after success/review, repeat reuses manual confirmation; other documents unchanged');
