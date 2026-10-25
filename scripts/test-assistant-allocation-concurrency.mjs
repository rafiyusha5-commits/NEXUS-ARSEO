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
run(read('../supabase/migrations/202610240700_assistant_expense_allocation.sql'));
let fixture=read('../supabase/tests/assistant_expense_allocation.test.sql').split('-- ALLOCATION FIXTURE END')[0]
 .replace('create temporary table eal','create table tests.eal').replaceAll('on eal','on tests.eal').replaceAll('insert into eal','insert into tests.eal').replaceAll('from eal','from tests.eal');
run(fixture+'\nreset role;commit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','b6400000-0000-4000-8000-000000000001',false);";
const ids=['b6490000-0000-4000-8000-000000000001','b6490000-0000-4000-8000-000000000002'];
const expense=run('select expense_id from tests.eal where n=1;');
const prepare=(id,e=expense)=>JSON.parse(run(actor+`select public.prepare_assistant_operation('${id}','expense_allocate',jsonb_build_object('expense_id','${e}','method','by_quantity','target_currency_id',(select id from public.currencies where code='EUR')));select public.review_assistant_operation('${id}');`).split('\n').find(x=>x.includes('review_token')));
const previews=ids.map(id=>prepare(id));
const confirm=i=>actor+`select public.confirm_assistant_operation('${ids[i]}','${previews[i].review_token}');`;
const race=await Promise.all(ids.map((_,i)=>parallel(confirm(i))));
assert.equal(race.filter(x=>x.ok).length,1,JSON.stringify(race));
assert.match(race.find(x=>!x.ok).output,/ASSISTANT_OPERATION_STALE/);
const retries=await Promise.all(Array.from({length:12},()=>parallel(confirm(race.findIndex(x=>x.ok)))));
assert.ok(retries.every(x=>x.ok),JSON.stringify(retries));
assert.equal(new Set(retries.map(x=>JSON.parse(x.output.split('\n').find(y=>y.includes('result_id'))).result_id)).size,1);
console.log('PASS expense allocation: two proposals => one allocation; 12 retries => same receipt');
const waitingId='b6490000-0000-4000-8000-000000000003';
const waiting=prepare(waitingId,run('select expense_id from tests.eal where n=2;'));
const holder=spawn(psql,[...args,'-tA'],{windowsHide:true});let stdout='',stderr='';
const closed=new Promise(resolve=>holder.on('close',resolve));
holder.stdout.on('data',d=>stdout+=d);holder.stderr.on('data',d=>stderr+=d);
holder.stdin.write("begin;select 1 from public.expenses where id=(select expense_id from tests.eal where n=2) for update;insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'b6400000-0000-4000-8000-000000000001',id,'deny','Concurrent expense denial','b6400000-0000-4000-8000-000000000001' from public.permissions where code='costing.calculate';select 'LOCK_HELD';\n");
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
 assert.equal(run("select count(*) from public.expenses where shipment_id='b6430000-0000-4000-8000-000000000001' and status='allocated' and paid_at is null;"),'1');
 console.log('PASS expense allocation: costing.calculate revoked during lock wait => no write');
}finally{if(!holder.stdin.writableEnded)holder.stdin.end('rollback;\n');await closed;if(pending)await pending;}

run("delete from public.user_permission_overrides where user_id='b6400000-0000-4000-8000-000000000001';");
const cancelledExpense=run('select expense_id from tests.eal where n=3;');
const cancelledId='b6490000-0000-4000-8000-000000000004';
const cancelledPreview=prepare(cancelledId,cancelledExpense);
const canceller=spawn(psql,[...args,'-tA'],{windowsHide:true});let cancelOut='',cancelErr='';
const cancelClosed=new Promise(resolve=>canceller.on('close',resolve));
canceller.stdout.on('data',d=>cancelOut+=d);canceller.stderr.on('data',d=>cancelErr+=d);
canceller.stdin.write(actor+`begin;select public.cancel_expense('${cancelledExpense}','Native cancellation race');select 'LOCK_HELD';\n`);
let afterCancel;
try{
 for(let n=0;n<100&&!cancelOut.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(cancelOut.includes('LOCK_HELD'),cancelErr);
 afterCancel=parallel(actor+`select public.confirm_assistant_operation('${cancelledId}','${cancelledPreview.review_token}');`);
 let blocked=false;
 for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${cancelledId}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
 assert.ok(blocked,'confirmation waits for native cancellation');
 canceller.stdin.end('commit;\n');assert.equal(await cancelClosed,0,cancelErr);
 const r=await afterCancel;assert.equal(r.ok,false);assert.match(r.output,/ASSISTANT_ALLOCATION_STATE/);
 assert.equal(run(`select status from public.expenses where id='${cancelledExpense}';`),'cancelled');
 console.log('PASS expense allocation: native cancellation wins during real lock wait; no resurrection or payment');
}finally{if(!canceller.stdin.writableEnded)canceller.stdin.end('rollback;\n');await cancelClosed;if(afterCancel)await afterCancel;}
const changedExpense=run('select expense_id from tests.eal where n=4;');
const changedId='b6490000-0000-4000-8000-000000000005';
const changedPreview=prepare(changedId,changedExpense);
const changer=spawn(psql,[...args,'-tA'],{windowsHide:true});let changeOut='',changeErr='';
const changeClosed=new Promise(resolve=>changer.on('close',resolve));
changer.stdout.on('data',d=>changeOut+=d);changer.stderr.on('data',d=>changeErr+=d);
changer.stdin.write(`begin;lock table public.expenses in exclusive mode;update public.shipment_items set received_quantity=9 where id='b6440000-0000-4000-8000-000000000001';select 'LOCK_HELD';\n`);
let afterChange;
try{
 for(let n=0;n<100&&!changeOut.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(changeOut.includes('LOCK_HELD'),changeErr);
 afterChange=parallel(actor+`select public.confirm_assistant_operation('${changedId}','${changedPreview.review_token}');`);
 let blocked=false;
 for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${changedId}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
 assert.ok(blocked,'allocation waits for source transaction');
 changer.stdin.end('commit;\n');assert.equal(await changeClosed,0,changeErr);
 const r=await afterChange;assert.equal(r.ok,false);assert.match(r.output,/ASSISTANT_OPERATION_STALE/);
 assert.equal(run(`select count(*) from public.expense_allocations where expense_id='${changedExpense}';`),'0');
 console.log('PASS expense allocation: quantity source changes during real lock wait => stale preview; no allocation');
}finally{if(!changer.stdin.writableEnded)changer.stdin.end('rollback;\n');await changeClosed;if(afterChange)await afterChange;}
