// Disposable PostgreSQL only; synthetic fixture, no external services.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [bin, ...args] = process.argv.slice(2);
if (!bin || !args.includes('ON_ERROR_STOP=1')) throw Error('Use isolated SQL runner');
const run = sql => execFileSync(bin, [...args, '-tA'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 }).trim();
let fixture = readFileSync(new URL('../supabase/tests/calculator_protected_fields.test.sql', import.meta.url), 'utf8');
fixture = fixture.slice(0, fixture.indexOf('create temporary table protected_before'))
  .replaceAll('protected_fixture', 'tests.calculator_fields_race_fixture').replace('create temporary table', 'create table');
run(fixture + '\ncommit;');
const actor = "set role authenticated;select set_config('request.jwt.claim.sub','e8820000-0000-4000-8000-000000000001',false);";
const operation = actor + 'select public.import_calculator_master_data((select payload from tests.calculator_fields_race_fixture),false);';
function start() {
  const p = spawn(bin, [...args, '-tA'], { windowsHide: true }); let out = '';
  p.stdout.on('data', s => out += s); p.stderr.on('data', s => out += s);
  const done = new Promise((resolve, reject) => { p.on('error', reject); p.on('close', code => resolve({ code, out })); });
  return { p, done, output: () => out };
}
const call = sql => { const h = start(); h.p.stdin.end(sql); return h.done; };
for (const denied of [false, true]) {
  const holder = start(); let pending;
  try {
    // The importer must wait for a real product row lock, then read the committed
    // manual correction and re-check permissions before it can write anything.
    holder.p.stdin.write("begin;update public.products set shelf_life_days=550,hs_code='1806329010' where internal_sku='PROTECT-1';select 'HELD';\n");
    for (let n = 0; n < 100 && !holder.output().includes('HELD'); n++) await new Promise(r => setTimeout(r, 25));
    assert.ok(holder.output().includes('HELD'));
    pending = call(operation);
    let waiting = false;
    for (let n = 0; n < 100 && !waiting; n++) {
      waiting = run("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and query like '%select public.import_calculator_master_data%');") === 't';
      if (!waiting) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(waiting, 'import waits for the product row');
    if (denied) run("insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'e8820000-0000-4000-8000-000000000001',id,'deny','Concurrent denial','e8820000-0000-4000-8000-000000000001' from public.permissions where code='products.view';");
    holder.p.stdin.end('commit;\n');
    assert.equal((await holder.done).code, 0);
    const result = await pending;
    assert.equal(result.code === 0, !denied, result.out);
    if (denied) assert.match(result.out, /Недостаточно прав/);
    assert.equal(run("select shelf_life_days=550 and hs_code='1806329010' from public.products where internal_sku='PROTECT-1';"), 't');
  } finally {
    if (holder.p.exitCode === null) holder.p.stdin.end('rollback;\n');
    await holder.done; if (pending) await pending;
    run("delete from public.user_permission_overrides where user_id='e8820000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code='products.view');");
  }
}
const results = await Promise.all(Array.from({ length: 10 }, () => call(operation)));
assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
assert.equal(run("select count(*)=4 and bool_and(case when internal_sku='PROTECT-1' then shelf_life_days=550 and hs_code='1806329010' else true end) from public.products where internal_sku in('PROTECT-1','EMPTY-1','NEW-1','CANON-1');"), 't');
console.log('Calculator protected fields: concurrent manual correction preserved, access revocation refused, ten repeat imports create no duplicates');
