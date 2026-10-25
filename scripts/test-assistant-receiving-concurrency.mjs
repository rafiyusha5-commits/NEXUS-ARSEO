// Only invoked inside the disposable test-db cluster; no application connection or credentials.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [psql,...args]=process.argv.slice(2);
if(!psql||!args.includes('ON_ERROR_STOP=1'))throw Error('Use isolated SQL runner');
const run=sql=>execFileSync(psql,[...args,'-tA'],{input:sql,encoding:'utf8',windowsHide:true,maxBuffer:4e6}).trim();
const parallel=sql=>new Promise((resolve,reject)=>{const c=spawn(psql,[...args,'-tA'],{windowsHide:true});let output='';c.stdout.on('data',d=>output+=d);c.stderr.on('data',d=>output+=d);c.on('error',reject);c.on('close',code=>resolve({ok:code===0,output}));c.stdin.end(sql);});
const source=readFileSync(new URL('../supabase/tests/assistant_receiving.test.sql',import.meta.url),'utf8').replaceAll('\r\n','\n');
const marker='do $$declare c ar_context;';
assert.ok(source.includes(marker));
// The older assistant concurrency suite intentionally replays 0500. Restore the final
// schema before testing its successor; never weaken the older regression assertions.
run(readFileSync(new URL('../supabase/migrations/202610240100_assistant_receiving.sql',import.meta.url),'utf8').replaceAll('\r\n','\n'));
run(source.split(marker)[0].replace('create temporary table ar_context','create table tests.ar_context').replaceAll(' ar_context',' tests.ar_context')+'\nreset role;commit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','a8240000-0000-4000-8000-000000000001',false);";
const ids=['a8243000-0000-4000-8000-000000000091','a8243000-0000-4000-8000-000000000092'];
const previews=ids.map(id=>JSON.parse(run(actor+`select public.prepare_assistant_operation('${id}','shipment_transport_receive',payload) from tests.ar_context;select public.review_assistant_operation('${id}');`).split('\n').find(l=>l.includes('review_token'))));
const confirm=i=>actor+`select public.confirm_assistant_operation('${ids[i]}','${previews[i].review_token}');`;
const race=await Promise.all(ids.map((_,i)=>parallel(confirm(i))));
assert.equal(race.filter(r=>r.ok).length,1,JSON.stringify(race));
assert.match(race.find(r=>!r.ok).output,/ASSISTANT_RECEIVING_STATE/);
const winner=race.findIndex(r=>r.ok);
const retries=await Promise.all(Array.from({length:12},()=>parallel(confirm(winner))));
assert.ok(retries.every(r=>r.ok),JSON.stringify(retries));
assert.equal(new Set(retries.map(r=>JSON.parse(r.output.split('\n').find(l=>l.includes('result_id'))).result_id)).size,1);
run(`do $$begin
 assert (select count(*) from public.shipment_transport_receipts where shipment_transport_id=(select transport from tests.ar_context))=1;
 assert (select sum(quantity) from public.inventory_movements where shipment_transport_id=(select transport from tests.ar_context))=92;
end $$;`);
console.log('PASS assistant receiving: two proposals => one receipt; 12 retries => same receipt, exactly 92 stock units');
