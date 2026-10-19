// Run only against the disposable test database used by test:db.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass psql and disposable database arguments');
async function run(sql) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args, '-X', '-q', '-tA', '-v', 'ON_ERROR_STOP=1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', b => out += b); child.stderr.on('data', b => err += b);
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(out.trim()); else reject(new Error(err)); });
    child.stdin.end("set statement_timeout='20s';\n" + sql);
  });
}
const fixture = (await readFile(new URL('../supabase/tests/fixtures/source_integrity.sql', import.meta.url), 'utf8')).replaceAll('eb', 'd9').replaceAll('DQ', 'DRIVE-RACE').replaceAll('@test.local', '@drive-race.test');
await run(fixture);
const shipment = 'd9300000-0000-4000-8000-000000000001';
const who = `set role authenticated; select set_config('request.jwt.claim.sub','d9000000-0000-4000-8000-000000000001',false); select set_config('request.headers',jsonb_build_object('x-nexus-drive-gateway',repeat('a',64))::text,false);`;
await run(`insert into private.drive_gateway_config(id,secret_sha256) values(true,encode(sha256(convert_to(repeat('a',64),'UTF8')),'hex')) on conflict(id) do update set secret_sha256=excluded.secret_sha256;
${who}
select public.bind_shipment_drive_folder('${shipment}','Concurrent_folder_123','Synthetic');
select public.scan_shipment_drive_folder(shipment_id,generation,'[{"file_id":"Concurrent_file_123","name":"test.pdf","path":"test.pdf","mime_type":"application/pdf","revision":"1","size":100}]') from public.shipment_drive_folders where shipment_id='${shipment}';
`);
await Promise.all(Array.from({ length: 10 }, (_, i) => {
  const doc = `d9400000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const path = `documents/${doc}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-test.pdf`;
  return run(`${who}
insert into storage.objects(bucket_id,name,owner_id,metadata) values('nexus-documents','${path}','d9000000-0000-4000-8000-000000000001','{"size":100,"mimetype":"application/pdf"}');
select public.import_shipment_drive_file('${shipment}','Concurrent_file_123','1',repeat('9',64),'${doc}',(select id from public.document_types where code='invoice'),'${path}');`);
}));
assert.equal(await run(`select count(*) from public.document_versions where checksum_sha256=repeat('9',64);`), '1');
assert.equal(await run(`select count(*) from public.document_links where entity_id='${shipment}' and document_id::text like 'd940%' and removed_at is null;`), '1');
assert.equal(await run(`select count(*) from public.shipment_drive_files where shipment_id='${shipment}' and imported_document_id is not null;`), '1');
console.log('shipment-drive: ten concurrent imports -> one document, one link, one receipt');
const second = 'd9300000-0000-4000-8000-000000000002';
const copies = Array.from({ length: 10 }, (_, i) => ({ file_id: `Concurrent_copy_${i}`, name: 'copy.pdf', path: `copy-${i}.pdf`, mime_type: 'application/pdf', revision: '1', size: 100 }));
await run(`${who}
select public.bind_shipment_drive_folder('${second}','Concurrent_folder_456','Synthetic second');
select public.scan_shipment_drive_folder(shipment_id,generation,'${JSON.stringify(copies)}') from public.shipment_drive_folders where shipment_id in ('${shipment}','${second}');`);
await Promise.all(copies.map((file, i) => {
  const doc = `d9410000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
  const path = `documents/${doc}/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-copy.pdf`;
  return run(`${who}
insert into storage.objects(bucket_id,name,owner_id,metadata) values('nexus-documents','${path}','d9000000-0000-4000-8000-000000000001','{"size":100,"mimetype":"application/pdf"}');
select public.import_shipment_drive_file('${i % 2 ? shipment : second}','${file.file_id}','1',repeat('8',64),'${doc}',(select id from public.document_types where code='invoice'),'${path}');`);
}));
assert.equal(await run("select count(*) from public.document_versions where checksum_sha256=repeat('8',64);"), '1');
assert.equal(await run("select count(*) from public.document_links where document_id::text like 'd941%' and removed_at is null;"), '2');
assert.equal(await run("select count(*) from public.shipment_drive_files where imported_checksum=repeat('8',64);"), '10');
console.log('shipment-drive: ten copied files across two shipments -> one document, two links');
