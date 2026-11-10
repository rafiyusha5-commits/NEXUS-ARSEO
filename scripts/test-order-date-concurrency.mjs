// Disposable database only, invoked with the PostgreSQL test runner's explicit connection.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [psql,...args]=process.argv.slice(2);
if(!psql||!args.includes('ON_ERROR_STOP=1'))throw Error('Use isolated SQL runner');
const run=sql=>execFileSync(psql,[...args,'-tA'],{input:sql,encoding:'utf8',windowsHide:true}).trim();
const parallel=sql=>new Promise((resolve,reject)=>{
 const p=spawn(psql,[...args,'-tA'],{windowsHide:true});let output='';
 p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);p.on('error',reject);
 p.on('close',code=>resolve({ok:code===0,output}));p.stdin.end(sql);
});
const fixture=readFileSync(new URL('../supabase/tests/fixtures/historical_sales.sql',import.meta.url),'utf8')
 .replaceAll('tests.historical_context','tests.date_race_context').replace(/af([0-9]{6}-)/g,'ad$1')
 .replaceAll('historical-admin@','date-race-admin@').replaceAll('historical-director@','date-race-director@').replaceAll('HIST-','DATE-RACE-');
run('begin;'+fixture+`select set_config('request.jwt.claim.sub','ad010000-0000-4000-8000-000000000001',true);insert into public.sales(id,sale_number,customer_id,warehouse_id,currency_id,sale_date,planned_shipment_date,status)
 select 'ad710000-0000-4000-8000-000000000001','DATE-RACE-TEST','ad110000-0000-4000-8000-000000000002',
 'ad210000-0000-4000-8000-000000000001',id,private.business_today()-5,private.business_today()-1,'draft' from public.currencies where code='EUR';commit;`);
const actor="set role authenticated;select set_config('request.jwt.claim.sub','ad010000-0000-4000-8000-000000000001',false);";
const dates=run("select (private.business_today()-1)||','||(private.business_today()-5);").split(',');
const call=n=>actor+`select public.correct_customer_order_date('ad710000-0000-4000-8000-000000000001','ad810000-0000-4000-8000-${String(n).padStart(12,'0')}','${dates[0]}','${dates[1]}','Concurrent synthetic date correction');`;
const repeats=await Promise.all(Array.from({length:10},()=>parallel(call(1))));
assert.ok(repeats.every(r=>r.ok),JSON.stringify(repeats));
assert.equal(run("select count(*) from public.sale_shipment_date_changes where sale_id='ad710000-0000-4000-8000-000000000001';"),'1');
console.log('PASS date correction: ten simultaneous retries, one history record');
run(`delete from public.sale_shipment_date_changes where sale_id='ad710000-0000-4000-8000-000000000001';update public.sales set planned_shipment_date='${dates[0]}' where id='ad710000-0000-4000-8000-000000000001';`);
const race=await Promise.all([2,3].map(n=>parallel(call(n))));
assert.equal(race.filter(r=>r.ok).length,1,JSON.stringify(race));assert.match(race.find(r=>!r.ok).output,/уже изменилась/);
assert.equal(run("select count(*) from public.sale_shipment_date_changes where sale_id='ad710000-0000-4000-8000-000000000001';"),'1');
assert.equal(run("select count(*) from public.inventory_movements where sale_id='ad710000-0000-4000-8000-000000000001';"),'0');
console.log('PASS date correction: competing requests, one correction, no stock movement');
