// Disposable PostgreSQL only. Usage: node script.mjs psql [connection options...]
// Partial payments under concurrency (202611170400): parallel payments of one expense never exceed its amount,
// and the same request repeated in parallel is one payment.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass psql and the disposable database connection arguments');
function start(sql) {
  const child = spawn(command, [...args, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.on('data', (data) => { stdout += data; });
  child.stderr.on('data', (data) => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 30000);
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  child.stdin.end(`set statement_timeout='20s';\n${sql}`);
  return result;
}
async function run(sql) {
  const result = await start(sql);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim();
}

const user = 'd4900000-0000-4000-8000-000000000001';
const customer = 'd4900000-0000-4000-8000-000000000002';
const payee = 'd4900000-0000-4000-8000-000000000003';
const who = `set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`;
await run(`
insert into auth.users(id,email,raw_user_meta_data) values ('${user}','payables-race@example.invalid','{"full_name":"Payables race"}');
insert into public.user_roles(user_id,role_id) select '${user}',id from public.app_roles where code='director';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('${customer}',array['customer'],'Payables race customer','KZ','D49-C'),('${payee}',array['carrier'],'Payables race carrier','KZ','D49-P');
create table tests_payables_race(k text primary key,id uuid);
-- A helper of this test, read by the racing sessions as authenticated: new tables carry no read access by default.
grant select on tests_payables_race to authenticated;
with e as (
 insert into public.expenses(attributed_customer_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,is_planned,status,confirmed_by,confirmed_at,created_by,notes)
 values ('${customer}','promo','${payee}',100,(select id from public.currencies where code='EUR'),current_date,false,'confirmed','${user}',now(),'${user}','Race')
 returning id)
insert into tests_payables_race select 'expense',id from e;`);
const expense = await run(`select id from tests_payables_race where k='expense'`);
const pay = (amount, request = 'gen_random_uuid()') =>
  start(`${who} select public.record_expense_payment(${request},'${expense}',${amount},current_date,null,'Race');`);
const paid = async () => Number(await run(`select coalesce(sum(amount),0) from public.payment_applications where expense_id='${expense}'`));

// Two employees pay 60 of 100 at the same moment: one payment passes, the other is refused.
let results = await Promise.all([pay(60), pay(60)]);
assert.equal(results.filter((r) => r.code === 0).length, 1, JSON.stringify(results));
assert.ok(results.some((r) => /превышает сумму расхода/.test(r.stderr)), JSON.stringify(results));
assert.equal(await paid(), 60);

// The same request ten times in parallel: one payment of 10.
results = await Promise.all(Array.from({ length: 10 }, () => pay(10, "'d4900000-0000-4000-8000-0000000000aa'")));
assert.ok(results.every((r) => r.code === 0), JSON.stringify(results.filter((r) => r.code !== 0)));
assert.equal(await paid(), 70);

// Eight payments of 10 for the remaining 30: exactly three pass, never more than the amount.
results = await Promise.all(Array.from({ length: 8 }, () => pay(10)));
assert.equal(results.filter((r) => r.code === 0).length, 3, JSON.stringify(results.map((r) => r.stderr)));
assert.equal(await paid(), 100);
await run(`select 1 where (select status from public.expenses where id='${expense}')='confirmed'`);
// Advances (202611170700): one advance of 100 set off at the same moment against two expenses, 60 each: one passes.
await run(`
with e as (
 insert into public.expenses(attributed_customer_id,expense_type,payee_counterparty_id,amount,currency_id,incurred_at,is_planned,status,confirmed_by,confirmed_at,created_by,notes)
 select '${customer}','promo','${payee}',100,(select id from public.currencies where code='EUR'),current_date,false,'confirmed','${user}',now(),'${user}','Race '||g
 from generate_series(1,2) g returning id)
insert into tests_payables_race select 'advance-expense-'||row_number() over (),id from e;
insert into public.payments(id,payee_counterparty_id,currency_id,amount,paid_on,created_by,kind,advance_for)
 values ('d4900000-0000-4000-8000-0000000000ad','${payee}',(select id from public.currencies where code='EUR'),100,current_date,'${user}','advance','services');`);
const setOff = (key) => start(`${who} select public.apply_advance(gen_random_uuid(),'d4900000-0000-4000-8000-0000000000ad',(select id from tests_payables_race where k='${key}'),60);`);
const setOffs = await Promise.all([setOff('advance-expense-1'), setOff('advance-expense-2')]);
assert.equal(setOffs.filter((r) => r.code === 0).length, 1, JSON.stringify(setOffs.map((r) => r.stderr)));
assert.ok(setOffs.some((r) => /распределены: остаток 40/.test(r.stderr)), JSON.stringify(setOffs.map((r) => r.stderr)));
assert.equal(await run(`select sum(amount) from public.payment_applications where payment_id='d4900000-0000-4000-8000-0000000000ad'`), '60.00');
console.log('PASS advances: two parallel set-offs of one advance => one, never above the advance');
console.log('PASS payables: 2 parallel overpaying payments => one; 10 repeated requests => one payment; 8 payments for 3 remaining => 3, never above the amount');
