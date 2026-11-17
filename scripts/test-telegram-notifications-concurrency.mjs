// Disposable PostgreSQL only. Usage: node script.mjs psql [connection options...]
// Telegram delivery under concurrency (202611170600): parallel workers never claim one delivery twice, so one
// notification can never become two Telegram messages. No Telegram call is made.
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
const user = 'ab790000-0000-4000-8000-000000000001';
// Ten o'clock tomorrow in Kazakhstan: outside quiet hours whatever the hour of the run.
const at = "((current_date + 1 + time '10:00') at time zone 'Asia/Almaty')";
await run(`
insert into auth.users(id,email,raw_user_meta_data) values ('${user}','tg-race@example.invalid','{"full_name":"Telegram race"}');
insert into public.user_roles(user_id,role_id) select '${user}',id from public.app_roles where code='director';
insert into public.telegram_links(user_id,chat_id,display_name,linked_at) values ('${user}',79001,'Race',now());
insert into public.telegram_notification_settings(user_id,enabled,types) values ('${user}',true,array['task_assigned']);
insert into public.notifications(recipient_user_id,type,title,entity_type,entity_id)
 select '${user}','task_assigned','Race '||g,'task',gen_random_uuid() from generate_series(1,30) g;`);
assert.equal(await run(`select count(*) from public.notification_deliveries where recipient_user_id='${user}' and status='queued'`), '30');
const workers = await Promise.all(Array.from({ length: 8 }, () => start(`select public.telegram_notification_batch(10, ${at});`)));
assert.ok(workers.every((r) => r.code === 0), JSON.stringify(workers.map((r) => r.stderr)));
const claimed = workers.flatMap((r) => JSON.parse(r.stdout.trim()).users.flatMap((u) => u.items.map((i) => i.id)));
assert.equal(new Set(claimed).size, claimed.length, 'a delivery claimed by two workers');
assert.equal(claimed.length, 30, 'every queued delivery claimed exactly once');
assert.equal(await run(`select count(*) from public.notification_deliveries where recipient_user_id='${user}' and status='sending'`), '30');
console.log('PASS telegram delivery: 8 parallel workers claim 30 deliveries, each exactly once');
