// Disposable PostgreSQL only. Usage: node script.mjs psql [connection options...]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass psql and the disposable database connection arguments');
function start(sql) {
  const child = spawn(command, [...args, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', finished = false;
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 20000);
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => { finished = true; clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  child.stdin.end(`set statement_timeout='15s';\n${sql}`);
  return { result, done: () => finished };
}
async function run(sql) {
  const result = await start(sql).result;
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}
const who = "set role authenticated; select set_config('request.jwt.claim.sub','ed000000-0000-4000-8000-000000000001',false);";
const shipment = 'ed300000-0000-4000-8000-000000000003';
const item = 'ed400000-0000-4000-8000-000000000004';
const calculate = `select public.calculate_shipment_cost('${shipment}',(select id from public.currencies where code='EUR'));`;
const approve = `select public.approve_shipment_cost((select id from public.cost_calculations where shipment_id='${shipment}' order by version_number desc limit 1));`;
const cost = `select goods_total from public.cost_calculations where shipment_id='${shipment}' order by version_number desc limit 1`;
async function race(operation, mutation) {
  const first = start(`set application_name='cost-race-holder'; ${who} ${operation}`);
  let waiting = false;
  for (let i = 0; i < 100; i++) {
    waiting = await run("select exists(select 1 from pg_stat_activity where application_name='cost-race-holder' and wait_event='PgSleep')") === 't';
    if (waiting) break;
    if (first.done()) break;
    await delay(25);
  }
  assert.ok(waiting, 'The deterministic pause inside the operation was reached');
  const second = start(`${who} ${mutation}`);
  await delay(150);
  const blocked = !second.done();
  const a = await first.result, b = await second.result;
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  assert.ok(blocked, 'A source write must wait until calculation/approval commits');
}
await run(await readFile(new URL('../supabase/tests/fixtures/cost_concurrency.sql', import.meta.url), 'utf8'));
await run(`
create function tests.pause_cost_input() returns trigger language plpgsql as $$begin
 if current_setting('application_name')='cost-race-holder' then perform pg_sleep(2); end if; return new;
end$$;
create trigger pause_cost_calculation before insert on public.cost_calculation_items for each row execute function tests.pause_cost_input();
create trigger pause_cost_approval before update on public.cost_calculations for each row when (new.status='approved') execute function tests.pause_cost_input();`);
try {
  await race(calculate, `select public.update_shipment_item('${item}',10,4);`);
  assert.equal(await run(cost), '20.00');
  const stale = await start(`${who} ${approve}`).result;
  assert.notEqual(stale.code, 0, 'A price changed after calculation must prevent approval');
  assert.match(stale.stderr, /После расчёта изменились/);
  await run(`${who} ${calculate}`);
  assert.equal(await run(cost), '40.00');

  const newExpense = `select public.create_expense('${shipment}','other',null,1,(select id from public.currencies where code='EUR'),current_date,false,null,'Concurrency expense');`;
  await race(calculate, newExpense);
  const staleExpense = await start(`${who} ${approve}`).result;
  assert.notEqual(staleExpense.code, 0, 'A new expense must prevent stale approval');
  assert.match(staleExpense.stderr, /После расчёта изменились/);
  await run(`${who} select public.cancel_expense(id,'Test cleanup') from public.expenses where shipment_id='${shipment}' and status='draft'; ${calculate}`);

  await race(approve, `select public.update_shipment_item('${item}',10,6);`);
  assert.equal(await run(cost), '40.00', 'Approval finished before the price edit');
  await run(`${who} ${calculate}`);
  assert.equal(await run(cost), '60.00');
  await race(approve, newExpense);
  console.log('Cost concurrency passed: price and new expense serialize with calculation and approval');
} finally {
  await run('drop trigger pause_cost_calculation on public.cost_calculation_items; drop trigger pause_cost_approval on public.cost_calculations; drop function tests.pause_cost_input();');
}
