// Run only through the disposable PostgreSQL test runner; no external services.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
const [bin, ...args] = process.argv.slice(2);
if (!bin || !args.includes('ON_ERROR_STOP=1')) throw Error('Use isolated SQL runner');
const run = sql => execFileSync(bin, [...args, '-tA'], { input: sql, encoding: 'utf8', windowsHide: true, maxBuffer: 4e6 }).trim();
let fixture = readFileSync(new URL('../supabase/tests/calculator_schema_review.test.sql', import.meta.url), 'utf8');
fixture = fixture.slice(0, fixture.indexOf('create temporary table calc_schema_before'))
  .replaceAll('calc_schema_fixture', 'tests.calculator_schema_race_fixture').replace('create temporary table', 'create table');
run(fixture + '\ngrant select on tests.calculator_schema_race_fixture to authenticated;commit;');
const actor = "set role authenticated;select set_config('request.jwt.claim.sub','e8610000-0000-4000-8000-000000000001',false);";
const source = '(select new_source from tests.calculator_schema_race_fixture)';
const token = run(actor + `select public.review_calculator_schema(${source})->>'expected_schema';`).split('\n').at(-1);
const approval = actor + `select public.review_calculator_schema(${source},true,'${token}');`;
const before = Number(run('select count(*) from private.calculator_schema_approvals;'));
function start() {
  const p = spawn(bin, [...args, '-tA'], { windowsHide: true }); let out = '';
  p.stdout.on('data', s => out += s); p.stderr.on('data', s => out += s);
  const done = new Promise((resolve, reject) => { p.on('error', reject); p.on('close', code => resolve({ code, out })); });
  return { p, done, output: () => out };
}
const call = sql => { const h = start(); h.p.stdin.end(sql); return h.done; };
const results = await Promise.all(Array.from({ length: 10 }, () => call(approval)));
assert.ok(results.every(r => r.code === 0), JSON.stringify(results));
assert.equal(Number(run('select count(*) from private.calculator_schema_approvals;')), before + 1);

// Both the reviewer and the importer must re-check access and schema after
// waiting for the same lock, including otherwise harmless idempotent retries.
for (const kind of ['review-permission', 'import-permission', 'stale-import', 'stale-approval']) {
  const holder = start(); let pending;
  const payload = `jsonb_build_object('format','nexus-calculator-import','version',1,'reference',
    jsonb_build_object('format','nexus-reference-import','version',1,'products','[]'::jsonb,'counterparties','[]'::jsonb),'source',${source})`;
  const operation = kind.startsWith('import') || kind === 'stale-import'
    ? actor + `select public.import_calculator_master_data(${payload},false);`
    : kind === 'stale-approval'
      ? actor + `select public.review_calculator_schema(jsonb_set(${source},'{columns}',(${source}->'columns')||
        '{"key":"source.установленные_цены.доп_цена","field_ru":"Доп цена","position":6,"block":"УСТАНОВЛЕННЫЕ ЦЕНЫ","visibility":"sales"}'::jsonb),true,
        '${run(actor + `select public.review_calculator_schema(${source})->>'expected_schema';`).split('\n').at(-1)}');`
      : approval;
  try {
    holder.p.stdin.write("begin;select pg_advisory_xact_lock(hashtextextended('nexus.calculator_import',0));select 'HELD';\n");
    for (let n = 0; n < 100 && !holder.output().includes('HELD'); n++) await new Promise(r => setTimeout(r, 25));
    assert.ok(holder.output().includes('HELD'));
    pending = call(operation);
    let waiting = false;
    for (let n = 0; n < 100 && !waiting; n++) {
      waiting = run("select exists(select 1 from pg_stat_activity where wait_event_type='Lock' and (query like '%review_calculator_schema%' or query like '%import_calculator_master_data%'));") === 't';
      if (!waiting) await new Promise(r => setTimeout(r, 25));
    }
    assert.ok(waiting, kind + ': real lock wait');
    if (kind.endsWith('permission')) run("insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'e8610000-0000-4000-8000-000000000001',id,'deny','Concurrent denial','e8610000-0000-4000-8000-000000000001' from public.permissions where code='products.update';");
    holder.p.stdin.end((kind.startsWith('stale') ? "update public.product_master_sources set header_fingerprint='race-changed' where source_key='arseo-master-calculator';" : '') + 'commit;\n');
    assert.equal((await holder.done).code, 0);
    const result = await pending;
    assert.notEqual(result.code, 0, kind + ': must reject');
    assert.match(result.out, kind.endsWith('permission') ? /[Нн]ет доступа|Недостаточно прав/ : /Структура/);
    assert.equal(Number(run('select count(*) from private.calculator_schema_approvals;')), before + 1);
  } finally {
    if (holder.p.exitCode === null) holder.p.stdin.end('rollback;\n');
    await holder.done; if (pending) await pending;
    run("delete from public.user_permission_overrides where user_id='e8610000-0000-4000-8000-000000000001' and permission_id=(select id from public.permissions where code='products.update');update public.product_master_sources set header_fingerprint='schema-review-new' where source_key='arseo-master-calculator';");
  }
}
console.log('Calculator schema: ten concurrent approvals produce one history row; access revocation and stale source under lock refuse review/import');
