// Only the disposable PostgreSQL test database. Tests real locks, not a mocked RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass psql and disposable database arguments');
function start(sql) {
  const child = spawn(command, [...args, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', done = false;
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  const timer = setTimeout(() => child.kill(), 15000);
  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); done = true; resolve({ code, stdout, stderr }); });
  });
  child.stdin.end(`set statement_timeout='10s';\n${sql}`);
  return { result, done: () => done };
}
async function run(sql) { const r = await start(sql).result; assert.equal(r.code, 0, r.stderr); return r.stdout.trim(); }
const who = "set role authenticated; select set_config('request.jwt.claim.sub','eb000000-0000-4000-8000-000000000001',false);";
const doc = 'eb503000-0000-4000-8000-000000000001';
const v1 = 'eb513000-0000-4000-8000-000000000001';
const v2 = 'eb513000-0000-4000-8000-000000000002';
const e1 = 'eb603000-0000-4000-8000-000000000001';
const shipment = 'eb300000-0000-4000-8000-000000000001';
const review = `select public.review_shipment_source_extraction('${e1}','{"invoice_number":"STALE"}',false);`;
async function race(mutation, operation) {
  const holder = start(`set application_name='source-integrity-holder'; begin; ${mutation} select pg_sleep(2); commit;`);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await run("select exists(select 1 from pg_stat_activity where application_name='source-integrity-holder' and wait_event='PgSleep')") === 't';
    if (ready || holder.done()) break;
    await delay(20);
  }
  assert.ok(ready, 'Concurrent mutation holds the source lock');
  const request = start(`${who} ${operation}`);
  await delay(100);
  assert.equal(request.done(), false, 'RPC must wait for the source mutation');
  const a = await holder.result, b = await request.result;
  assert.equal(a.code, 0, a.stderr);
  assert.notEqual(b.code, 0, 'Outdated source was accepted after the competing transaction committed');
  assert.match(b.stderr, /отвязан|отклонён|новой версией|закрыт|завершено/);
}
await run(await readFile(new URL('../supabase/tests/fixtures/source_integrity.sql', import.meta.url), 'utf8'));
await race(`update public.document_links set removed_at=now(),removed_by='eb000000-0000-4000-8000-000000000001' where document_id='${doc}';`, review);
await run(`update public.document_links set removed_at=null,removed_by=null where document_id='${doc}';`);
await race(`update public.documents set status='rejected' where id='${doc}';`, review);
await run(`update public.documents set status='approved' where id='${doc}';`);
const newVersion = `update public.documents set current_version=2 where id='${doc}';
update public.document_versions set is_current=false where id='${v1}';
set session_replication_role=replica;
insert into public.document_versions(id,document_id,version_number,storage_path,original_filename,mime_type,file_size_bytes,is_current,uploaded_by)
select '${v2}',document_id,2,replace(storage_path,'d.pdf','v2.pdf'),'v2.pdf',mime_type,file_size_bytes,true,uploaded_by from public.document_versions where id='${v1}';
set session_replication_role=origin;
${who} select public.upsert_shipment_source_extraction('${shipment}','${doc}','${v2}','invoice','extracted','{"invoice_number":"NEW"}');`;
await race(newVersion, `select public.upsert_shipment_source_extraction('${shipment}','${doc}','${v1}','invoice','extracted','{"invoice_number":"STALE"}');`);
assert.equal(await run(`select status||':'||(extracted_data->>'invoice_number') from public.shipment_source_extractions where document_version_id='${v2}';`), 'extracted:NEW');
assert.equal(await run(`select count(*) from public.shipment_items where shipment_id='${shipment}' and (confirmed_quantity is not null or shipped_quantity is not null);`), '0');
console.log('source integrity concurrency: unlink, rejection, late v1 against v2 passed');
