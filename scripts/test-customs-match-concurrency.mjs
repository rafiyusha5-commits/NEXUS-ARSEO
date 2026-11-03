// Disposable PostgreSQL only. No credentials or external services.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [bin,...args]=process.argv.slice(2);
if(!bin||!args.includes('ON_ERROR_STOP=1'))throw Error('Use isolated SQL runner');
const run=s=>execFileSync(bin,[...args,'-tA'],{input:s,encoding:'utf8',windowsHide:true,maxBuffer:4e6}).trim();
let sql=readFileSync(new URL('../supabase/tests/customs_line_matches.test.sql',import.meta.url),'utf8').split('create function pg_temp.save_match')[0];
sql=sql.replace('\\ir fixtures/source_integrity.sql',readFileSync(new URL('../supabase/tests/fixtures/source_integrity.sql',import.meta.url),'utf8'))
 .replaceAll('match_fixture','tests.customs_match_fixture').replace('create temporary table','create table');
run(sql+'\ncommit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);";
const save=actor+`select public.save_shipment_customs_match('eb603000-0000-4000-8000-000000000001','eb601000-0000-4000-8000-000000000001','eb602000-0000-4000-8000-000000000001',(select snapshot from tests.customs_match_fixture),(select lines from tests.customs_match_fixture),'Сверены три синтетических оригинала и партии',null);`;
function start(){
 const p=spawn(bin,[...args,'-tA'],{windowsHide:true});let out='';
 p.stdout.on('data',s=>out+=s);p.stderr.on('data',s=>out+=s);
 const done=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',code=>resolve({code,out}));});
 return{p,done,out:()=>out};
}
const call=s=>{const h=start();h.p.stdin.end(s);return h.done;};
const saves=await Promise.all(Array.from({length:10},()=>call(save)));
assert.ok(saves.every(s=>s.code===0),JSON.stringify(saves));
assert.equal(run('select count(*) from public.shipment_customs_matches'), '1');
const id=run('select id from public.shipment_customs_matches limit 1');
const audit=()=>Number(run("select count(*) from public.audit_log where entity_type='shipment_source_extractions' and entity_id='eb603000-0000-4000-8000-000000000001'"));
const beforeAudit=audit();
const review=actor+`select public.review_mapped_shipment_customs('eb603000-0000-4000-8000-000000000001','${id}',(select extracted_data->'customs_record' from public.shipment_source_extractions where id='eb603000-0000-4000-8000-000000000001'),'Синтетическое подтверждение оригинала');`;
const reviews=await Promise.all(Array.from({length:10},()=>call(review)));
assert.ok(reviews.every(s=>s.code===0),JSON.stringify(reviews));assert.equal(audit(),beforeAudit+1,'Repeated review duplicated history');
const holder=start();let pending;
try {
 holder.p.stdin.write("begin;select 1 from public.documents where id='eb501000-0000-4000-8000-000000000001' for update;select 'LOCK_HELD';\n");
 for(let n=0;n<100&&!holder.out().includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(holder.out().includes('LOCK_HELD'));
 pending=call(review);let waiting=false;
 for(let n=0;n<100&&!waiting;n++){
  waiting=run("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%review_mapped_shipment_customs%')")==='t';
  if(!waiting)await new Promise(r=>setTimeout(r,25));
 }
 assert.ok(waiting);
 holder.p.stdin.end("update public.shipment_source_extractions set extracted_data=jsonb_set(extracted_data,'{commodity_invoice,total}','101') where id='eb601000-0000-4000-8000-000000000001';commit;\n");
 assert.equal((await holder.done).code,0);assert.notEqual((await pending).code,0);
} finally {if(holder.p.exitCode===null)holder.p.stdin.end('rollback;\n');}
assert.equal(audit(),beforeAudit+1,'Stale confirmation wrote history');
assert.equal(run('select count(*) from public.shipment_customs_matches'),'1');
assert.equal(run('select count(*)=(select movements from tests.customs_match_fixture) from public.inventory_movements'),'t');
console.log('Customs: 10 saves -> one mapping; 10 reviews -> one audit entry; changed invoice during lock wait -> refused; stock unchanged');
