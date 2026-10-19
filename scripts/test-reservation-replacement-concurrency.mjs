// Real concurrent PostgreSQL sessions. Called ONLY by test-db.sh against its disposable cluster.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass psql and disposable test cluster arguments');
function start(sql, name = 'rr-check') {
  const child = spawn(command, [...args, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', done = false;
  child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
  const timer = setTimeout(() => child.kill(), 20000);
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { done = true; clearTimeout(timer); resolve({ code, stdout: stdout.trim(), stderr }); });
  });
  child.stdin.end(`set statement_timeout='15s'; set application_name='${name}';\n${sql}`);
  return { result, done: () => done };
}
async function run(sql) { const r = await start(sql).result; assert.equal(r.code, 0, r.stderr); return r.stdout; }
async function waitFor(condition, session) {
  for (let n = 0; n < 150; n++) {
    if (await run(condition) === 't') return;
    if (session.done()) break;
    await delay(20);
  }
  throw new Error(`Session never reached the expected concurrent wait: ${(await session.result).stderr}`);
}
const fixture = await readFile(new URL('../supabase/tests/fixtures/reservation_replacement.sql', import.meta.url), 'utf8');
let index = 0;
async function setup() {
  const prefix = `d${(++index).toString(16)}`;
  const context = `tests.rr_context_${prefix}`, planFn = `tests.rr_plan_${prefix}`;
  await run(fixture.replace(/ee(?=[0-9a-f]{6}-)/g, prefix)
    .replaceAll('-8000-', '-8f77-')
    .replaceAll('replacement@example.invalid', `replacement-${prefix}@example.invalid`)
    .replaceAll('RR', `RR-${prefix}`).replaceAll('tests.rr_context', context).replaceAll('tests.rr_plan', planFn));
  const actor = `${prefix}000000-0000-4000-8f77-000000000001`;
  const second = `${prefix}000000-0000-4000-8f77-000000000002`;
  await run(`insert into auth.users(id,email,raw_user_meta_data) values('${second}','${prefix}@example.invalid','{"full_name":"Synthetic second employee"}');
    insert into public.user_roles(user_id,role_id) select '${second}',id from public.app_roles where code='director';`);
  const who = `set role authenticated; set request.jwt.claim.sub='${actor}';`;
  const who2 = `set role authenticated; set request.jwt.claim.sub='${second}';`;
  const sale = `(select id from ${context} where k='sale')`, other = `(select id from ${context} where k='other')`;
  const preview = async target => JSON.parse(await run(`${who} select public.preview_customer_order_reservation_replacement(${target})->'snapshot';`));
  const replacement = async (target = sale, key = 'item', request = 1) => {
    const snap = JSON.stringify(await preview(target)).replaceAll("'", "''");
    return `select public.replace_customer_order_reservations(${target},'${prefix}900000-0000-4000-8f77-00000000000${request}','${snap}'::jsonb,${planFn}('${key}'),'Synthetic concurrent replacement');`;
  };
  return { prefix, context, who, who2, sale, other, replacement };
}
async function race(holderSql, waiterSql, expectedError = null) {
  const holder = start(`begin; ${holderSql} select pg_sleep(3); commit;`, 'rr-holder');
  await waitFor("select exists(select 1 from pg_stat_activity where application_name='rr-holder' and wait_event='PgSleep')", holder);
  const waiter = start(waiterSql, 'rr-waiter');
  await waitFor("select exists(select 1 from pg_stat_activity where application_name='rr-waiter' and wait_event_type='Lock')", waiter);
  const [a, b] = await Promise.all([holder.result, waiter.result]);
  assert.equal(a.code, 0, a.stderr);
  if (expectedError) { assert.notEqual(b.code, 0); assert.match(b.stderr, expectedError); }
  else assert.equal(b.code, 0, b.stderr);
}
async function invariant(c, events = 1) {
  assert.equal(await run(`select count(*) from public.sale_reservation_replacements where sale_id in(${c.sale},${c.other});`), String(events));
  assert.equal(await run(`select not exists(select 1 from public.inventory_balances b where b.warehouse_id='${c.prefix}200000-0000-4000-8f77-000000000001'
    and (b.quantity_reserved>b.quantity_on_hand or b.quantity_reserved<>(select coalesce(sum(r.quantity),0) from public.inventory_reservations r where r.inventory_balance_id=b.id and r.status='active')));`), 't');
}
// Distinct employees and request IDs, same order: the second preview is stale after waiting.
{
  const c = await setup(); const a = await c.replacement(), b = await c.replacement(c.sale, 'item', 2);
  await race(c.who + a, c.who2 + b, /Резервы заказа изменены/); await invariant(c);
}
// Same lost-response request: both succeed, one event and one allocation.
{
  const c = await setup(); const a = await c.replacement();
  await race(c.who + a, c.who + a); await invariant(c);
}
// Different orders share the last 20 pieces: only one can acquire them.
{
  const c = await setup(); const a = await c.replacement(), b = await c.replacement(c.other, 'other-item', 2);
  await race(c.who + a, c.who2 + b, /Недостаточный свободный/); await invariant(c);
  assert.equal(await run(`select sum(quantity_on_hand) from public.inventory_balances where warehouse_id='${c.prefix}200000-0000-4000-8f77-000000000001';`), '220.000');
}
// Fulfillment waits, then consumes the NEW reservations exactly once.
{
  const c = await setup(); const a = await c.replacement();
  await race(c.who + a, `${c.who2} select public.fulfill_customer_order(${c.sale});`); await invariant(c);
  assert.equal(await run(`select count(*)=2 and sum(quantity)=20 and bool_and(batch_id<>'${c.prefix}400000-0000-4000-8f77-000000000001') from public.inventory_movements where sale_id=${c.sale};`), 't');
}
// Fulfillment wins first: replacement must not revive shipped reservations.
{
  const c = await setup();
  await run(`${c.who} select public.set_inventory_batch_status('${c.prefix}400000-0000-4000-8f77-000000000001','available',null);`);
  const a = await c.replacement();
  await race(`${c.who} select public.fulfill_customer_order(${c.sale});`, c.who2 + a, /Состояние заказа изменилось/); await invariant(c, 0);
}
// Cancellation wins first; replacement waits and refuses the cancelled order.
{
  const c = await setup(); const a = await c.replacement();
  await race(`${c.who} select public.cancel_customer_order(${c.sale},'Synthetic cancellation');`, c.who2 + a, /Состояние заказа изменилось/); await invariant(c, 0);
}
// Batch control wins first while replacement is waiting for its batch lock.
{
  const c = await setup(); const a = await c.replacement();
  await race(`${c.who} select public.set_inventory_batch_status('${c.prefix}400000-0000-4000-8f77-000000000002','blocked','Synthetic block');`, c.who2 + a, /заблокирована/); await invariant(c, 0);
}
// Reverse order: control waits until replacement commits; subsequent fulfillment must reject the now blocked batch.
{
  const c = await setup(); const a = await c.replacement();
  await race(c.who + a, `${c.who2} select public.set_inventory_batch_status('${c.prefix}400000-0000-4000-8f77-000000000002','blocked','Synthetic block');`); await invariant(c);
  const r = await start(`${c.who} select public.fulfill_customer_order(${c.sale});`).result;
  assert.notEqual(r.code, 0); assert.match(r.stderr, /заблокирована/);
}
// Personal deny is committed while the writer waits for the order: access must be rechecked AFTER waiting.
{
  const c = await setup(); const a = await c.replacement();
  await race(`select 1 from public.sales where id=${c.sale} for update;
    insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
    select '${c.prefix}000000-0000-4000-8f77-000000000001',id,'deny','Synthetic concurrent deny','${c.prefix}000000-0000-4000-8f77-000000000001'
    from public.permissions where code='sales.reserve';`, c.who + a, /Недостаточно прав/);
  await invariant(c, 0);
}
// Replacement wins first, then cancellation releases the NEW reserves and retains replacement history.
{
  const c = await setup(); const a = await c.replacement();
  await race(c.who + a, `${c.who2} select public.cancel_customer_order(${c.sale},'Synthetic cancellation');`); await invariant(c);
  assert.equal(await run(`select count(*) from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=${c.sale} and r.status='active';`), '0');
  assert.equal(await run(`select count(*) from public.inventory_movements where sale_id=${c.sale};`), '0');
}
console.log('reservation replacement concurrency: 10 real lock-wait scenarios passed');
