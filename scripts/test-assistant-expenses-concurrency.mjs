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
run(read('../supabase/migrations/202610240500_assistant_expenses.sql'));
// This race needs no document. The transactional SQL fixture's synthetic
// declaration intentionally has no stored file and must not be committed.
run(read('../supabase/tests/assistant_expenses.test.sql').split('-- Explicit declaration fixture')[0]+'\ncommit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','ae000000-0000-4000-8000-000000000001',false);";
const payload=JSON.stringify({shipment_id:'ae300000-0000-4000-8000-000000000001',expense_type:'transport',payee_counterparty_id:null,amount:'1250.50',currency_id:run("select id from public.currencies where code='EUR';"),incurred_at:'2026-10-24',amount_kind:'actual',document_id:null,notes:null});
const ids=['ae900000-0000-4000-8000-000000000001','ae900000-0000-4000-8000-000000000002'];
const prepare=(id,p=payload)=>JSON.parse(run(actor+`select public.prepare_assistant_operation('${id}','expense_create','${p}'::jsonb);select public.review_assistant_operation('${id}');`).split('\n').find(x=>x.includes('review_token')));
const previews=ids.map(id=>prepare(id));
const confirm=i=>actor+`select public.confirm_assistant_operation('${ids[i]}','${previews[i].review_token}');`;
const race=await Promise.all(ids.map((_,i)=>parallel(confirm(i))));
assert.equal(race.filter(x=>x.ok).length,1,JSON.stringify(race));
assert.match(race.find(x=>!x.ok).output,/ASSISTANT_OPERATION_STALE/);
const retries=await Promise.all(Array.from({length:12},()=>parallel(confirm(race.findIndex(x=>x.ok)))));
assert.ok(retries.every(x=>x.ok),JSON.stringify(retries));
assert.equal(new Set(retries.map(x=>JSON.parse(x.output.split('\n').find(y=>y.includes('result_id'))).result_id)).size,1);
console.log('PASS expenses: competing proposals create one draft; 12 retries return the same receipt');
const waitingId='ae900000-0000-4000-8000-000000000003';
const waiting=prepare(waitingId,payload.replace('1250.50','1999.50'));
const holder=spawn(psql,[...args,'-tA'],{windowsHide:true});let stdout='',stderr='';
const closed=new Promise(resolve=>holder.on('close',resolve));
holder.stdout.on('data',d=>stdout+=d);holder.stderr.on('data',d=>stderr+=d);
holder.stdin.write("begin;select 1 from public.shipments where id='ae300000-0000-4000-8000-000000000001' for update;insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'ae000000-0000-4000-8000-000000000001',id,'deny','Concurrent expense denial','ae000000-0000-4000-8000-000000000001' from public.permissions where code in ('finance.manage','finance.draft');select 'LOCK_HELD';\n");
let pending;
try{
 for(let n=0;n<100&&!stdout.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(stdout.includes('LOCK_HELD'),stderr);
 pending=parallel(actor+`select public.confirm_assistant_operation('${waitingId}','${waiting.review_token}');`);
 let blocked=false;
 for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${waitingId}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
 assert.ok(blocked,'confirm waited for shipment lock');
 holder.stdin.end('commit;\n');assert.equal(await closed,0,stderr);
 const r=await pending;assert.equal(r.ok,false);assert.match(r.output,/ASSISTANT_OPERATION_DENIED/);
 assert.equal(run("select count(*) from public.expenses where shipment_id='ae300000-0000-4000-8000-000000000001';"),'1');
 console.log('PASS expenses: finance permission revoked during lock wait => no write');
}finally{if(!holder.stdin.writableEnded)holder.stdin.end('rollback;\n');await closed;if(pending)await pending;}
