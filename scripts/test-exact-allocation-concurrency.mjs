// Invoked only by the disposable PostgreSQL test runner, with its explicit psql arguments.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [psql, ...args] = process.argv.slice(2);
if (!psql || !args.includes('ON_ERROR_STOP=1')) throw Error('Use isolated SQL runner');
const run = sql => execFileSync(psql, [...args, '-tA'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 }).trim();
const parallel = sql => new Promise((resolve, reject) => {
 const p = spawn(psql, [...args, '-tA'], { windowsHide: true }); let output = '';
 p.stdout.on('data', d => output += d); p.stderr.on('data', d => output += d);
 p.on('error', reject); p.on('close', code => resolve({ ok: code === 0, output })); p.stdin.end(sql);
});
let fixture = readFileSync(new URL('../supabase/tests/exact_expense_allocation.test.sql', import.meta.url), 'utf8').replaceAll('\r\n','\n').split('-- EXACT FIXTURE END')[0];
fixture = fixture.replace('create temporary table exact_cases','create table tests.exact_cases').replaceAll('on exact_cases','on tests.exact_cases').replaceAll('insert into exact_cases','insert into tests.exact_cases').replaceAll('from exact_cases','from tests.exact_cases');
run(fixture+'\nreset role;commit;');
const actor = "set role authenticated;select set_config('request.jwt.claim.sub','ef500000-0000-4000-8000-000000000001',false);";
const expense = n => run(`select expense_id from tests.exact_cases where n=${n};`);
const currency = run("select id from public.currencies where code='EUR';");
const context = n => JSON.parse(run(actor+`select public.exact_expense_allocation_context('${expense(n)}','${currency}',null);`).split('\n').find(x=>x.startsWith('{')));
const lines = JSON.stringify([{item_id:'ef540000-0000-4000-8000-000000000001',amount:'23.45'},{item_id:'ef540000-0000-4000-8000-000000000002',amount:'100'}]);
const save = (c, id) => actor+`select public.save_exact_expense_allocation('${id}','${c.expense_id}','${currency}',null,'${c.stamp}','${lines}','Concurrent synthetic exact allocation');`;
const c1=context(1), id='ef590000-0000-4000-8000-000000000001';
const repeats=await Promise.all(Array.from({length:10},()=>parallel(save(c1,id))));
assert.ok(repeats.every(r=>r.ok),JSON.stringify(repeats));
assert.equal(run(`select count(*) from private.expense_allocation_revisions where expense_id='${c1.expense_id}';`),'1');
assert.equal(run(`select count(*) from public.expense_allocations where expense_id='${c1.expense_id}';`),'2');
console.log('PASS exact allocation: ten simultaneous retries => one revision, two active rows');
const c2=context(2);
const race=await Promise.all([2,3].map(n=>parallel(save(c2,`ef590000-0000-4000-8000-00000000000${n}`))));
assert.equal(race.filter(x=>x.ok).length,1,JSON.stringify(race));assert.match(race.find(x=>!x.ok).output,/Данные изменились/);
console.log('PASS exact allocation: two different requests for one snapshot => one success, one stale');
const c3=context(3), waitingId='ef590000-0000-4000-8000-000000000004';
const holder=spawn(psql,[...args,'-tA'],{windowsHide:true});let out='',err='';
holder.stdout.on('data',d=>out+=d);holder.stderr.on('data',d=>err+=d);const closed=new Promise(r=>holder.on('close',r));let pending;
try {
 holder.stdin.write("begin;lock table public.expenses in exclusive mode;insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'ef500000-0000-4000-8000-000000000001',id,'deny','Concurrent denial','ef500000-0000-4000-8000-000000000001' from public.permissions where code='costing.calculate';select 'LOCK_HELD';\n");
 for(let n=0;n<100&&!out.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
 assert.ok(out.includes('LOCK_HELD'),err);pending=parallel(save(c3,waitingId));
 let blocked=false;for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${waitingId}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
 assert.ok(blocked,'save waits for source lock');holder.stdin.end('commit;\n');assert.equal(await closed,0,err);
 const result=await pending;assert.equal(result.ok,false);assert.match(result.output,/права распределять/);
 assert.equal(run(`select count(*) from public.expense_allocations where expense_id='${c3.expense_id}';`),'0');
 console.log('PASS exact allocation: permission revoked while waiting => no write');
} finally { if(!holder.stdin.writableEnded)holder.stdin.end('rollback;\n');await closed;if(pending)await pending; }
