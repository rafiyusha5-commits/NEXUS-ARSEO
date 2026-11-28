// Disposable PostgreSQL only. Usage: node script.mjs psql [connection options...]
// Inventory counts under concurrency (202611280300): two employees counting one location at the same moment lose
// nothing; two corrections of one record — one passes; ending the round while records go in never drops a record that
// was accepted.
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

const a = 'cd000000-0000-4000-8000-000000000001';
const b = 'cd000000-0000-4000-8000-000000000002';
const as = (user) => `set role authenticated; select set_config('request.jwt.claim.sub','${user}',false);`;
await run(`
insert into auth.users(id,email,raw_user_meta_data) values
 ('${a}','count-race-a@example.invalid','{"full_name":"Count race A"}'),('${b}','count-race-b@example.invalid','{"full_name":"Count race B"}');
insert into public.user_roles(user_id,role_id) select u.id,r.id from (values ('${a}'::uuid),('${b}'::uuid)) u(id)
 join public.app_roles r on r.code='logistics_specialist';
create table tests_count_race(k text primary key,id uuid);
grant select on tests_count_race to authenticated;
insert into public.counterparties(id,roles,legal_name,country) values ('cd000000-0000-4000-8000-000000000003',array['manufacturer'],'Count race maker','FI');
insert into public.products(id,internal_sku,name,manufacturer_id,status)
 values ('cd000000-0000-4000-8000-000000000004','RACE-CNT','{"ru":"Товар гонки"}','cd000000-0000-4000-8000-000000000003','active');
insert into public.inventory_batches(id,product_id,batch_number,expiry_date,created_by)
 values ('cd000000-0000-4000-8000-000000000005','cd000000-0000-4000-8000-000000000004','RACE-CNT-B',current_date+100,'${a}');
with w as (select id from public.warehouses where status='active' and not is_virtual order by code desc limit 1),
     l as (insert into public.warehouse_locations(warehouse_id,code,zone) select id,'RACE-CNT-L','storage' from w returning id,warehouse_id)
insert into tests_count_race select 'location',id from l union all select 'warehouse',warehouse_id from l;
insert into public.inventory_balances(batch_id,warehouse_id,warehouse_location_id,uom,quantity_on_hand)
 values ('cd000000-0000-4000-8000-000000000005',(select id from tests_count_race where k='warehouse'),(select id from tests_count_race where k='location'),'piece',100);`);
const location = await run(`select id from tests_count_race where k='location'`);
const warehouse = await run(`select id from tests_count_race where k='warehouse'`);
const count = (await run(`${as(a)} select public.create_inventory_count('${warehouse}','partial',true,null,null);`)).split('\n').at(-1);
await run(`${as(a)} select public.set_inventory_count_scope('${count}',array['${location}'::uuid],null,false,null); select public.start_inventory_count('${count}');`);
const record = (user, quantity, supersedes = 'null') => start(`${as(user)} select public.record_inventory_count('${count}',1::smallint,'${location}',
  'cd000000-0000-4000-8000-000000000004','cd000000-0000-4000-8000-000000000005','piece',${quantity},null,${supersedes});`);

// Two corrections of one record at the same moment: one passes, the other is refused; the record is corrected once.
const first = await record(a, 5);
assert.equal(first.code, 0, first.stderr);
const entry = first.stdout.trim().split('\n').at(-1);
const corrections = await Promise.all([record(a, 7, `'${entry}'`), record(b, 7, `'${entry}'`)]);
assert.equal(corrections.filter((r) => r.code === 0).length, 1, JSON.stringify(corrections.map((r) => r.stderr)));
assert.ok(corrections.some((r) => /уже исправлена/.test(r.stderr)), JSON.stringify(corrections.map((r) => r.stderr)));
console.log('PASS inventory count: two parallel corrections of one record => one');

// Two employees count the same location while the round is ended. A session holds the count, then 20 records queue up,
// then the end of the round, then 20 more records: the first 20 are accepted and counted, the last 20 are refused
// (never stored as a recount), nothing in between is lost.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const holder = start(`begin; select 1 from public.inventory_counts where id='${count}' for update; select pg_sleep(2); commit;`);
await pause(300);
const before = Array.from({ length: 20 }, (_, i) => record(i % 2 ? b : a, 1));
await pause(400);
const finish = start(`${as(a)} select public.finish_inventory_count_round('${count}');`);
await pause(400);
const after = Array.from({ length: 20 }, (_, i) => record(i % 2 ? b : a, 1));
const [held, ended, early, late] = await Promise.all([holder, finish, Promise.all(before), Promise.all(after)]);
assert.equal(held.code, 0, held.stderr);
assert.equal(ended.code, 0, ended.stderr);
assert.ok(early.every((r) => r.code === 0), JSON.stringify(early.filter((r) => r.code !== 0).map((r) => r.stderr)));
assert.ok(late.every((r) => r.code !== 0 && /Подсчёт закрыт/.test(r.stderr)), JSON.stringify(late.map((r) => r.stderr || r.stdout)));
const counted = Number(await run(`select counted_quantity from public.inventory_count_lines where count_id='${count}'`));
assert.equal(counted, 7 + 20, `counted ${counted}: the corrected 7 and the 20 records sent before the end of the round`);
const stored = Number(await run(`select count(*) from public.inventory_count_entries where count_id='${count}' and quantity=1`));
assert.equal(stored, 20, 'a refused record is not stored');
console.log('PASS inventory count: records racing the end of the round => the 20 before it counted, the 20 after it refused');
