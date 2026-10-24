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
run(read('../supabase/migrations/202610240400_assistant_return_cancellation.sql'));
// Native synthetic fixture, committed only in the disposable cluster for separate connections.
let fixture = read('../supabase/tests/assistant_return_cancellation.test.sql').split('-- CANCELLATION FIXTURE END')[0];
fixture = fixture.replace('create temporary table cancel_context','reset role;create table cancel_context').replace('do $$declare n integer;', () => 'set role authenticated;do $$declare n integer;').replace(/\bcancel_context\b/g,'tests.ac_context');
fixture = fixture.replaceAll('pg_temp.id', 'tests.ac_id').replaceAll('pg_temp.fails', 'tests.ac_fails').replace('create temporary table rt', 'create table rt').replace(/\brt\b/g, 'tests.ac_rt');
// References in the copied fixture resolve its context table through a test-only search path.
run('set search_path=tests,public;\n' + fixture + '\nreset role;commit;');
const actor = "set search_path=tests,public;set role authenticated;select set_config('request.jwt.claim.sub','ac280000-0000-4000-8000-000000000001',false);";
const payload = "(select payload from tests.ac_context where n=1)";
const ids = ['ac290000-0000-4000-8000-000000000091', 'ac290000-0000-4000-8000-000000000092'];
const previews = ids.map(id => JSON.parse(run(actor + `select public.prepare_assistant_operation('${id}','customer_return_cancel',${payload});select public.review_assistant_operation('${id}');`).split('\n').find(x => x.includes('review_token'))));
run(read('../supabase/migrations/202610240400_assistant_return_cancellation.sql'));
const confirm = i => actor + `select public.confirm_assistant_operation('${ids[i]}','${previews[i].review_token}');`;
const race = await Promise.all(ids.map((_, i) => parallel(confirm(i))));
assert.equal(race.filter(r => r.ok).length, 1, JSON.stringify(race));
assert.match(race.find(r => !r.ok).output, /ASSISTANT_CANCEL_STATE/);
const retries = await Promise.all(Array.from({ length: 12 }, () => parallel(confirm(race.findIndex(r => r.ok)))));
assert.ok(retries.every(r => r.ok), JSON.stringify(retries));
assert.equal(new Set(retries.map(r => JSON.parse(r.output.split('\n').find(x => x.includes('result_id'))).result_id)).size, 1);
run("do $$begin assert (select count(*)=1 from public.customer_returns where sale_id=tests.ac_id('sale') and status='cancelled');assert (select quantity_on_hand=0 from public.inventory_balances where id='ac284000-0000-4000-8000-000000000001');end $$;");
console.log('PASS assistant cancellation: concurrent proposals => one cancellation; 12 retries => same receipt, zero stock change');
// Commit a personal deny while confirmation is actually waiting on the native return header lock.
const waitingId = 'ac290000-0000-4000-8000-000000000093';
const pendingPayload = "(select payload from tests.ac_context where n=2)";
const waitingPreview = JSON.parse(run(actor + `select public.prepare_assistant_operation('${waitingId}','customer_return_cancel',${pendingPayload});select public.review_assistant_operation('${waitingId}');`).split('\n').find(x => x.includes('review_token')));
const holder = spawn(psql, [...args, '-tA'], { windowsHide: true }); let stdout = '', stderr = '';
const closed = new Promise(resolve => holder.on('close', resolve));
holder.stdout.on('data', d => stdout += d); holder.stderr.on('data', d => stderr += d);
holder.stdin.write("begin;select 1 from public.customer_returns where id=(select return_id from tests.ac_context where n=2) for update;insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'ac280000-0000-4000-8000-000000000001',id,'deny','Concurrent denial','ac280000-0000-4000-8000-000000000001' from public.permissions where code='sales.returns';select 'LOCK_HELD';\n");
let confirmation;
try {
 for (let n = 0; n < 100 && !stdout.includes('LOCK_HELD'); n++) await new Promise(r => setTimeout(r, 25));
 assert.ok(stdout.includes('LOCK_HELD'), stderr);
 confirmation = parallel(actor + `select public.confirm_assistant_operation('${waitingId}','${waitingPreview.review_token}');`);
 let waiting = false;
 for (let n = 0; n < 100 && !waiting; n++) {
  waiting = run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${waitingId}%');`) === 't';
  if (!waiting) await new Promise(r => setTimeout(r, 25));
 }
 assert.ok(waiting, 'confirmation waited for return header lock');
 holder.stdin.end('commit;\n'); assert.equal(await closed, 0, stderr);
 const result = await confirmation; assert.equal(result.ok, false); assert.match(result.output, /ASSISTANT_OPERATION_DENIED/);
 run("do $$begin assert (select count(*)=1 from public.customer_returns where sale_id=tests.ac_id('sale') and status='cancelled');end $$;");
 console.log('PASS assistant cancellation: personal deny during real lock wait => no second cancellation');
} finally {
 if (!holder.stdin.writableEnded) holder.stdin.end('rollback;\n');
 await closed; if (confirmation) await confirmation;
}
// Native decision wins while cancellation waits: no cancellation after a disposition.
async function raceWithHeader(n, firstSql, secondSql, expected) {
 const blocker = spawn(psql, [...args, '-tA'], { windowsHide: true }); let out='', err='';
 const ended = new Promise(resolve=>blocker.on('close',resolve));
 blocker.stdout.on('data',d=>out+=d);blocker.stderr.on('data',d=>err+=d);
 blocker.stdin.write(actor+"begin;"+firstSql+";select 'HEADER_HELD';\n");
 let other;
 try {
  for(let i=0;i<100&&!out.includes('HEADER_HELD');i++) await new Promise(r=>setTimeout(r,25));
  assert.ok(out.includes('HEADER_HELD'),err);
  other=parallel("set application_name='cancel_native_race_"+n+"';"+actor+secondSql);
  let waiting=false;
  for(let i=0;i<100&&!waiting;i++){
   waiting=run("select exists(select 1 from pg_stat_activity where application_name='cancel_native_race_"+n+"' and wait_event_type='Lock');")==='t';
   if(!waiting)await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(waiting,'second operation really waits on header');
  blocker.stdin.end('commit;\n');assert.equal(await ended,0,err);
  const result=await other;assert.equal(result.ok,false,result.output);assert.match(result.output,expected);
 } finally {
  if(!blocker.stdin.writableEnded)blocker.stdin.end('rollback;\n');
  await ended;if(other)await other;
 }
}
run("delete from public.user_permission_overrides where user_id='ac280000-0000-4000-8000-000000000001';");
const newPreview=n=>{
 const id='ac290000-0000-4000-8000-00000000010'+n;
 const p=JSON.parse(run(actor+"select public.prepare_assistant_operation('"+id+"','customer_return_cancel',(select payload from tests.ac_context where n="+n+"));select public.review_assistant_operation('"+id+"');").split('\n').find(x=>x.includes('review_token')));
 return "select public.confirm_assistant_operation('"+id+"','"+p.review_token+"');";
};
const native=n=>"select public.decide_customer_return_item((select ri.id from public.customer_return_items ri join tests.ac_context c on c.return_id=ri.return_id where c.n="+n+"),'write_off',null,'Причина сотрудника');";
await raceWithHeader(3,native(3),newPreview(3),/ASSISTANT_CANCEL_STATE/);
await raceWithHeader(4,newPreview(4),native(4),/Возврат отменён/);
run("do $$begin assert (select status='closed' from public.customer_returns where id=(select return_id from tests.ac_context where n=3));assert (select status='cancelled' from public.customer_returns where id=(select return_id from tests.ac_context where n=4));assert not exists(select 1 from public.customer_return_items where return_id=(select return_id from tests.ac_context where n=4) and decision is not null);end $$;");
console.log('PASS assistant cancellation: native decision/cancel races in both directions serialize without deadlock');

