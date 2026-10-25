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
run(read('../supabase/migrations/202610240200_assistant_returns.sql'));
// Native synthetic fixture, committed only in the disposable cluster for separate connections.
let fixture = read('../supabase/tests/assistant_returns.test.sql').split('-- ASSISTANT RETURN FIXTURE END')[0];
fixture = fixture.replaceAll('pg_temp.id', 'tests.art_id').replaceAll('pg_temp.fails', 'tests.art_fails').replace('create temporary table rt', 'create table rt').replace(/\brt\b/g, 'tests.art_rt');
// References in the copied fixture resolve its context table through a test-only search path.
run('set search_path=tests,public;\n' + fixture + '\nreset role;commit;');
const actor = "set search_path=tests,public;set role authenticated;select set_config('request.jwt.claim.sub','ac250000-0000-4000-8000-000000000001',false);";
const payload = "jsonb_build_object('sale_id',tests.art_id('sale'),'reason','Повреждение','lines',jsonb_build_array(jsonb_build_object('sale_item_id',tests.art_id('item'),'batch_id','ac253000-0000-4000-8000-000000000001','quantity','2','reason_code','damaged')))";
const ids = ['af240000-0000-4000-8000-000000000091', 'af240000-0000-4000-8000-000000000092'];
const previews = ids.map(id => JSON.parse(run(actor + `select public.prepare_assistant_operation('${id}','customer_return_create',${payload});select public.review_assistant_operation('${id}');`).split('\n').find(x => x.includes('review_token'))));
const confirm = i => actor + `select public.confirm_assistant_operation('${ids[i]}','${previews[i].review_token}');`;
const race = await Promise.all(ids.map((_, i) => parallel(confirm(i))));
assert.equal(race.filter(r => r.ok).length, 1, JSON.stringify(race));
assert.match(race.find(r => !r.ok).output, /ASSISTANT_OPERATION_STALE/);
const retries = await Promise.all(Array.from({ length: 12 }, () => parallel(confirm(race.findIndex(r => r.ok)))));
assert.ok(retries.every(r => r.ok), JSON.stringify(retries));
assert.equal(new Set(retries.map(r => JSON.parse(r.output.split('\n').find(x => x.includes('result_id'))).result_id)).size, 1);
run("do $$begin assert (select count(*)=1 from public.customer_returns where sale_id=tests.art_id('sale'));assert (select quantity_on_hand=0 from public.inventory_balances where id='ac254000-0000-4000-8000-000000000001');end $$;");
console.log('PASS assistant returns: concurrent proposals => one return; 12 retries => same return, no sellable stock');
// Commit a personal deny while confirmation is actually waiting on the native sale lock.
const waitingId = 'af240000-0000-4000-8000-000000000093';
const waitingPreview = JSON.parse(run(actor + `select public.prepare_assistant_operation('${waitingId}','customer_return_create',${payload});select public.review_assistant_operation('${waitingId}');`).split('\n').find(x => x.includes('review_token')));
const holder = spawn(psql, [...args, '-tA'], { windowsHide: true }); let stdout = '', stderr = '';
const closed = new Promise(resolve => holder.on('close', resolve));
holder.stdout.on('data', d => stdout += d); holder.stderr.on('data', d => stderr += d);
holder.stdin.write("begin;select 1 from public.sales where id=tests.art_id('sale') for update;insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'ac250000-0000-4000-8000-000000000001',id,'deny','Concurrent denial','ac250000-0000-4000-8000-000000000001' from public.permissions where code='sales.returns';select 'LOCK_HELD';\n");
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
 assert.ok(waiting, 'confirmation waited for sale lock');
 holder.stdin.end('commit;\n'); assert.equal(await closed, 0, stderr);
 const result = await confirmation; assert.equal(result.ok, false); assert.match(result.output, /ASSISTANT_OPERATION_DENIED/);
 run("do $$begin assert (select count(*)=1 from public.customer_returns where sale_id=tests.art_id('sale'));end $$;");
 console.log('PASS assistant returns: personal deny during real lock wait => no second return');
} finally {
 if (!holder.stdin.writableEnded) holder.stdin.end('rollback;\n');
 await closed; if (confirmation) await confirmation;
}
