// Invoked only by the disposable PG16 test runner.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [psql, ...args] = process.argv.slice(2);
if (!psql || !args.includes('ON_ERROR_STOP=1')) throw Error('Use isolated SQL runner');
const run = sql => execFileSync(psql, [...args, '-tA'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 }).trim();
const parallel = sql => new Promise((resolve, reject) => {
 const child = spawn(psql, [...args, '-tA'], { windowsHide: true }); let output = '';
 child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
 child.on('error', reject); child.on('close', code => resolve({ ok: code === 0, output })); child.stdin.end(sql);
});
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
run(read('../supabase/migrations/202610241100_assistant_expense_reversal.sql'));
let fixture=read('../supabase/tests/assistant_expense_reversal.test.sql').split('-- REVERSE EXPENSE FIXTURE END')[0]
 .replace('create temporary table erv','create table tests.erv').replaceAll('on erv','on tests.erv').replaceAll('insert into erv','insert into tests.erv').replaceAll('from erv','from tests.erv');
run(fixture+'\nreset role;commit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','b6900000-0000-4000-8000-000000000001',false);";
const ids=['b6990000-0000-4000-8000-000000000001','b6990000-0000-4000-8000-000000000002'];
const expense=run('select expense_id from tests.erv where n=1;');
const prepare=(id,e=expense)=>JSON.parse(run(actor+`select public.prepare_assistant_operation('${id}','expense_reverse',jsonb_build_object('expense_id','${e}','reason','Duplicate invoice'));select public.review_assistant_operation('${id}');`).split('\n').find(x=>x.includes('review_token')));
const previews=ids.map(id=>prepare(id));
const confirm=i=>actor+`select public.confirm_assistant_operation('${ids[i]}','${previews[i].review_token}');`;
const race=await Promise.all(ids.map((_,i)=>parallel(confirm(i))));
assert.equal(race.filter(x=>x.ok).length,1,JSON.stringify(race));
assert.match(race.find(x=>!x.ok).output,/ASSISTANT_EXPENSE_REVERSE_STATE/);
const retries=await Promise.all(Array.from({length:12},()=>parallel(confirm(race.findIndex(x=>x.ok)))));
assert.ok(retries.every(x=>x.ok),JSON.stringify(retries));
assert.equal(new Set(retries.map(x=>JSON.parse(x.output.split('\n').find(y=>y.includes('result_id'))).result_id)).size,1);
console.log('PASS expense reversal: two proposals => one confirmation; 12 retries => same receipt');

const waitingId='b6990000-0000-4000-8000-000000000003';
const waiting=prepare(waitingId,run('select expense_id from tests.erv where n=2;'));
const holder=spawn(psql,[...args,'-tA'],{windowsHide:true});let stdout='',stderr='';
const closed=new Promise(resolve=>holder.on('close',resolve));
holder.stdout.on('data',d=>stdout+=d);holder.stderr.on('data',d=>stderr+=d);
holder.stdin.write("begin;select 1 from public.expenses where id=(select expense_id from tests.erv where n=2) for update;insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'b6900000-0000-4000-8000-000000000001',id,'deny','Concurrent expense denial','b6900000-0000-4000-8000-000000000001' from public.permissions where code='finance.pay';select 'LOCK_HELD';\n");
let pending;
try{
 for(let n=0;n<100&&!stdout.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(stdout.includes('LOCK_HELD'),stderr);
 pending=parallel(actor+`select public.confirm_assistant_operation('${waitingId}','${waiting.review_token}');`);
 let blocked=false;
 for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${waitingId}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
 assert.ok(blocked,'confirm waited for expense lock');
 holder.stdin.end('commit;\n');assert.equal(await closed,0,stderr);
 const r=await pending;assert.equal(r.ok,false);assert.match(r.output,/ASSISTANT_OPERATION_DENIED/);
 assert.equal(run("select count(*) from public.expenses where shipment_id='b6930000-0000-4000-8000-000000000001' and status='reversed' and paid_at is not null;"),'1');
 console.log('PASS expense reversal: finance.pay revoked during lock wait => no write');
}finally{if(!holder.stdin.writableEnded)holder.stdin.end('rollback;\n');await closed;if(pending)await pending;}

run("delete from public.user_permission_overrides where user_id='b6900000-0000-4000-8000-000000000001';");
const cancelledExpense=run('select expense_id from tests.erv where n=3;');
const cancelledId='b6990000-0000-4000-8000-000000000004';
const cancelledPreview=prepare(cancelledId,cancelledExpense);
const canceller=spawn(psql,[...args,'-tA'],{windowsHide:true});let cancelOut='',cancelErr='';
const cancelClosed=new Promise(resolve=>canceller.on('close',resolve));
canceller.stdout.on('data',d=>cancelOut+=d);canceller.stderr.on('data',d=>cancelErr+=d);
canceller.stdin.write(actor+`begin;select public.reverse_expense('${cancelledExpense}','Native cancellation race');select 'LOCK_HELD';\n`);
let afterCancel;
try{
 for(let n=0;n<100&&!cancelOut.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(cancelOut.includes('LOCK_HELD'),cancelErr);
 afterCancel=parallel(actor+`select public.confirm_assistant_operation('${cancelledId}','${cancelledPreview.review_token}');`);
 let blocked=false;
 for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${cancelledId}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
 assert.ok(blocked,'confirmation waits for native cancellation');
 canceller.stdin.end('commit;\n');assert.equal(await cancelClosed,0,cancelErr);
 const r=await afterCancel;assert.equal(r.ok,false);assert.match(r.output,/ASSISTANT_EXPENSE_REVERSE_STATE/);
 assert.equal(run(`select status from public.expenses where id='${cancelledExpense}';`),'reversed');
console.log('PASS expense reversal: native reversal wins during real lock wait; payment history retained');
}finally{if(!canceller.stdin.writableEnded)canceller.stdin.end('rollback;\n');await cancelClosed;if(afterCancel)await afterCancel;}
async function sourceRace(n,change,expected){
 const eid=run(`select expense_id from tests.erv where n=${n};`);

 const rid=`b6990000-0000-4000-8000-00000000000${n+2}`,v=prepare(rid,eid);
 const child=spawn(psql,[...args,'-tA'],{windowsHide:true});let out='',err='';
 const ended=new Promise(resolve=>child.on('close',resolve));
 child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
 child.stdin.write(actor+'begin;'+change(eid)+"select 'LOCK_HELD';\n");
 let pending;
 try{
  for(let k=0;k<100&&!out.includes('LOCK_HELD');k++)await new Promise(r=>setTimeout(r,25));
  assert.ok(out.includes('LOCK_HELD'),err);
  pending=parallel(actor+`select public.confirm_assistant_operation('${rid}','${v.review_token}');`);
  let blocked=false;
  for(let k=0;k<100&&!blocked;k++){
   blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${rid}%');`)==='t';
   if(!blocked)await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(blocked,'cancellation actually waited for source mutation');
  child.stdin.end('commit;\n');assert.equal(await ended,0,err);
  const result=await pending;assert.equal(result.ok,false);assert.match(result.output,expected);
  assert.equal(run(`select count(*) from private.assistant_operations where id='${rid}' and result_expense_id is not null;`),'0');
 }finally{if(!child.stdin.writableEnded)child.stdin.end('rollback;\n');await ended;if(pending)await pending;}
}
await sourceRace(4,eid=>`reset role;update public.expenses set paid_at=paid_at+interval '1 second' where id='${eid}';`,/ASSISTANT_EXPENSE_REVERSE_STALE/);
await sourceRace(5,eid=>`select public.allocate_expense('${eid}','by_quantity',(select id from public.currencies where code='EUR'));`,/ASSISTANT_EXPENSE_REVERSE_STALE/);
console.log('PASS expense reversal: payment and allocation during real lock waits prevent stale reversal');
