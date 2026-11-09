// Invoked only by the disposable PostgreSQL runner; all rows below are synthetic.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [bin, ...args] = process.argv.slice(2);
if (!bin || !args.includes('ON_ERROR_STOP=1')) throw Error('Use isolated SQL runner');
const run = sql => execFileSync(bin, [...args, '-tA'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 }).trim();
const fixture = readFileSync(new URL('../supabase/tests/kz_replenishment.test.sql', import.meta.url), 'utf8');
run(fixture.replace(/rollback;\s*$/, 'commit;'));
const profile = run("select id from public.replenishment_profiles where name='Тестовый расчёт';");
assert.match(profile, /^[0-9a-f-]{36}$/);
const actor = "set role authenticated;select set_config('request.jwt.claim.sub','a8000000-0000-4000-8000-000000000001',false);";
function start() {
  const p = spawn(bin, [...args, '-tA'], { windowsHide: true }); let out = '';
  p.stdout.on('data', s => out += s); p.stderr.on('data', s => out += s);
  const done = new Promise((resolve, reject) => { p.on('error', reject); p.on('close', code => resolve({ code, out })); });
  return { p, done, output: () => out };
}
const call = sql => { const h = start(); h.p.stdin.end(sql); return h.done; };
const request = 'a8700000-0000-4000-8000-000000000002';
const results = await Promise.all(Array.from({ length: 10 }, () => call(`${actor}select public.replenishment_capture('${profile}','${request}');`)));
assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
assert.equal(run(`select count(*) from public.replenishment_runs where id='${request}';`), '1');
// Two independent versions of one supplier must not create overlapping plans in a race.
const candidates = [];
for (let index = 0; index < 2; index++) {
  const settings = run(`select settings::text from public.replenishment_profiles where id='${profile}';`);
  const prepared = run(`${actor}
    do $$ declare p uuid;r uuid;f uuid;w jsonb;s jsonb; begin
      p:=public.replenishment_create_profile('a8100000-0000-4000-8000-000000000001','Concurrent ${index}','${settings.replaceAll("'", "''")}'::jsonb,'Synthetic parallel proposal');
      w:=public.replenishment_workspace(p);s:=w->'sources'->0;
      perform public.replenishment_set_purpose(p,s->>'id',s->>'signature',180,0,null,null,'Synthetic KZ split');
      r:=public.replenishment_capture(p,gen_random_uuid());
      f:=public.replenishment_prepare_draft(r,'forecast','[{"productId":"a8300000-0000-4000-8000-000000000002","city":"astana","quantity":120}]','Synthetic forecast');
      perform public.submit_forecast(f);perform public.review_forecast(f,true,'Synthetic review');perform public.approve_forecast(f);
    end $$;
    reset role;
    select json_build_object('run',d.run_id,'forecast',d.forecast_id) from public.replenishment_decisions d join public.replenishment_runs r on r.id=d.run_id join public.replenishment_profiles p on p.id=r.profile_id where p.name='Concurrent ${index}' and d.kind='forecast';`);
  candidates.push(JSON.parse(prepared.split(/\r?\n/).at(-1)));
}
const plans = await Promise.all(Array.from({ length: 10 }, (_, i) => {
  const c = candidates[i % 2];
  return call(`${actor}select public.replenishment_prepare_draft('${c.run}','purchase','[{"productId":"a8300000-0000-4000-8000-000000000002","quantity":120}]','Synthetic purchase','${c.forecast}');`);
}));
assert.equal(plans.filter(p => p.code === 0).length, 5, JSON.stringify(plans));
assert.ok(plans.filter(p => p.code !== 0).every(p => p.out.includes('незавершённый план закупки')), JSON.stringify(plans));
assert.equal(run("select count(distinct purchase_plan_id) from public.purchase_plan_lines where product_id='a8300000-0000-4000-8000-000000000002';"), '1');
const holder = start(); let pending;
try {
  holder.p.stdin.write(`begin;select id from public.replenishment_profiles where id='${profile}' for update;select 'HELD';\n`);
  for (let n = 0; n < 100 && !holder.output().includes('HELD'); n++) await new Promise(r => setTimeout(r, 25));
  assert.ok(holder.output().includes('HELD'));
  pending = call(`${actor}select public.replenishment_capture('${profile}','a8700000-0000-4000-8000-000000000003');`);
  let waiting = false;
  for (let n = 0; n < 100 && !waiting; n++) {
    waiting = run("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%select public.replenishment_capture%');") === 't';
    if (!waiting) await new Promise(r => setTimeout(r, 25));
  }
  assert.ok(waiting);
  run("insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'a8000000-0000-4000-8000-000000000001',id,'deny','Concurrent denial','a8000000-0000-4000-8000-000000000001' from public.permissions where code='inventory.view';");
  holder.p.stdin.end('commit;\n'); assert.equal((await holder.done).code, 0);
  const refused = await pending; assert.notEqual(refused.code, 0); assert.match(refused.out, /Недостаточно прав/);
  assert.equal(run("select count(*) from public.replenishment_runs where id='a8700000-0000-4000-8000-000000000003';"), '0');
} finally {
  if (holder.p.exitCode === null) holder.p.stdin.end('rollback;\n'); await holder.done; if (pending) await pending;
}
console.log('KZ replenishment: ten captures -> one snapshot; ten competing proposals across profiles -> one plan; revoked access during lock wait -> denied');
