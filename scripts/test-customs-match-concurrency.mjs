// Disposable PostgreSQL only. No credentials or external services.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [bin,...args]=process.argv.slice(2);
if(!bin||!args.includes('ON_ERROR_STOP=1'))throw Error('Use isolated SQL runner');
// Other concurrency scenarios commit the shared fixture in the same disposable DB.
// Use a distinct namespace for IDs, emails, SKU and tax IDs; do not delete their data.
const isolate=s=>s.replaceAll('-0000-4000-8000-','-8c82-4000-8000-').replaceAll('DQ-','CMAP-').replaceAll('dq-','cmap-');
const run=s=>execFileSync(bin,[...args,'-tA'],{input:isolate(s),encoding:'utf8',windowsHide:true,maxBuffer:4e6}).trim();
let sql=readFileSync(new URL('../supabase/tests/customs_line_matches.test.sql',import.meta.url),'utf8').split('create function pg_temp.save_match')[0];
sql=sql.replace('\\ir fixtures/source_integrity.sql',readFileSync(new URL('../supabase/tests/fixtures/source_integrity.sql',import.meta.url),'utf8'))
 .replaceAll('match_fixture','tests.customs_match_race_fixture').replace('create temporary table','create table');
run(sql+'\ncommit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);";
const save=actor+`select public.save_shipment_customs_match('eb603000-0000-4000-8000-000000000001','eb601000-0000-4000-8000-000000000001','eb602000-0000-4000-8000-000000000001',(select snapshot from tests.customs_match_race_fixture),(select lines from tests.customs_match_race_fixture),'Сверены три синтетических оригинала и партии',null);`;
function start(){
 const p=spawn(bin,[...args,'-tA'],{windowsHide:true});let out='';
 p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>out+=s);
 const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',code=>resolve({code,out}));});
 return{p,done,out:()=>out};
}
const call=s=>{const h=start();h.p.stdin.end(isolate(s));return h.done;};
const saves=await Promise.all(Array.from({length:10},()=>call(save)));
assert.ok(saves.every(s=>s.code===0),JSON.stringify(saves));
const matching="from public.shipment_customs_matches where extraction_id='eb603000-0000-4000-8000-000000000001'";
assert.equal(run('select count(*) '+matching), '1');
const id=run('select id '+matching+' limit 1');
const audit=()=>Number(run("select count(*) from public.audit_log where entity_type='shipment_source_extractions' and entity_id='eb603000-0000-4000-8000-000000000001'"));
const beforeAudit=audit();
const review=actor+`select public.review_mapped_shipment_customs('eb603000-0000-4000-8000-000000000001','${id}',(select extracted_data->'customs_record' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'),'Синтетическое подтверждение оригинала');`;
const reviews=await Promise.all(Array.from({length:10},()=>call(review)));
assert.ok(reviews.every(s=>s.code===0),JSON.stringify(reviews));assert.equal(audit(),beforeAudit+1,'Repeated review duplicated history');
// Permission can be revoked while the RPC waits: check it again after the wait,
// including for an otherwise idempotent replay of an old confirmation.
const deniedHolder=start();let deniedPending;
try {
 deniedHolder.p.stdin.write(isolate("begin;select 1 from public.documents where id='eb501000-0000-4000-8000-000000000001' for update;select 'LOCK_HELD';\n"));
 for(let n=0;n<100&&!deniedHolder.out().includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(deniedHolder.out().includes('LOCK_HELD'));
 deniedPending=call(review);let waiting=false;
 for(let n=0;n<100&&!waiting;n++){
  waiting=run("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%review_mapped_shipment_customs%')")==='t';
  if(!waiting)await new Promise(r=>setTimeout(r,25));
 }
 assert.ok(waiting);
 run("insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'eb000000-0000-4000-8000-000000000001',id,'deny','Concurrent review denial','eb000000-0000-4000-8000-000000000001' from public.permissions where code='source_documents.review';");
 deniedHolder.p.stdin.end('commit;\n');assert.equal((await deniedHolder.done).code,0);
 const result=await deniedPending;assert.notEqual(result.code,0,'Review permission revoked during wait must refuse');assert.match(result.out,/Недостаточно прав/);
 assert.equal(audit(),beforeAudit+1);
} finally {
 if(deniedHolder.p.exitCode===null)deniedHolder.p.stdin.end('rollback;\n');
 await deniedHolder.done;if(deniedPending)await deniedPending;
 run("delete from public.user_permission_overrides where user_id='eb000000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code='source_documents.review');");
}
const holder=start();let pending;
try {
 holder.p.stdin.write(isolate("begin;select 1 from public.documents where id='eb501000-0000-4000-8000-000000000001' for update;select 'LOCK_HELD';\n"));
 for(let n=0;n<100&&!holder.out().includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(holder.out().includes('LOCK_HELD'));
 pending=call(review);let waiting=false;
 for(let n=0;n<100&&!waiting;n++){
  waiting=run("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%review_mapped_shipment_customs%')")==='t';
  if(!waiting)await new Promise(r=>setTimeout(r,25));
 }
 assert.ok(waiting);
 holder.p.stdin.end(isolate("update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{commodity_invoice,total}','101') where id='eb601000-0000-4000-8000-000000000001';commit;\n"));
 assert.equal((await holder.done).code,0);assert.notEqual((await pending).code,0);
} finally {if(holder.p.exitCode===null)holder.p.stdin.end('rollback;\n');}
assert.equal(audit(),beforeAudit+1,'Stale confirmation wrote history');
assert.equal(run('select count(*) '+matching),'1');
assert.equal(run('select count(*)=(select movements from tests.customs_match_race_fixture) from public.inventory_movements'),'t');
console.log('Customs: 10 saves -> one mapping; 10 reviews -> one audit entry; review permission revoked and invoice changed during real lock waits -> refused; stock unchanged');
