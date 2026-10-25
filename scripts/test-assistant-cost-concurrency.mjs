// Run only inside the disposable PostgreSQL 16 suite.
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [psql,...args]=process.argv.slice(2);
if(!psql||!args.includes('ON_ERROR_STOP=1'))throw Error('Use isolated SQL runner');
const run=sql=>execFileSync(psql,[...args,'-tA'],{input:sql,encoding:'utf8',windowsHide:true,maxBuffer:4e6}).trim();
const parallel=sql=>new Promise((resolve,reject)=>{const c=spawn(psql,[...args,'-tA'],{windowsHide:true});let output='';
 c.stdout.on('data',d=>output+=d);c.stderr.on('data',d=>output+=d);c.on('error',reject);c.on('close',code=>resolve({ok:code===0,output}));c.stdin.end(sql);});
const read=p=>readFileSync(new URL(p,import.meta.url),'utf8').replaceAll('\r\n','\n');
run(read('../supabase/migrations/202610240800_assistant_cost_calculation.sql'));
const fixture=read('../supabase/tests/assistant_cost_calculation.test.sql').split('-- COST FIXTURE END')[0]
 .replace('create temporary table cst','create table tests.cst').replaceAll('on cst','on tests.cst').replaceAll('into cst','into tests.cst');
run(fixture+'\nreset role;commit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','b6500000-0000-4000-8000-000000000001',false);";
const shipment='b6530000-0000-4000-8000-000000000001';
let counter=0;
const prepare=()=>{const id='b6590000-0000-4000-8000-'+String(++counter).padStart(12,'0');
 const v=JSON.parse(run(actor+`select public.prepare_assistant_operation('${id}','shipment_cost_calculate',(select p from tests.cst));select public.review_assistant_operation('${id}');`).split('\n').find(x=>x.includes('review_token')));
 return {id,token:v.review_token};};
const confirm=p=>actor+`select public.confirm_assistant_operation('${p.id}','${p.token}');`;
const proposals=[prepare(),prepare()];
const race=await Promise.all(proposals.map(p=>parallel(confirm(p))));
assert.equal(race.filter(x=>x.ok).length,1,JSON.stringify(race));assert.match(race.find(x=>!x.ok).output,/ASSISTANT_OPERATION_STALE/);
const retries=await Promise.all(Array.from({length:12},()=>parallel(confirm(proposals[race.findIndex(x=>x.ok)]))));
assert.ok(retries.every(x=>x.ok),JSON.stringify(retries));
assert.equal(run(`select count(*) from public.cost_calculations where shipment_id='${shipment}';`),'1');
console.log('PASS assistant costing: two proposals => one draft; 12 retries => same calculation');
async function waitRace(change,expected){
 const p=prepare(),holder=spawn(psql,[...args,'-tA'],{windowsHide:true});let output='',errors='';
 const closed=new Promise(resolve=>holder.on('close',resolve));holder.stdout.on('data',d=>output+=d);holder.stderr.on('data',d=>errors+=d);
 holder.stdin.write(`begin;lock table public.expenses in exclusive mode;${change};select 'LOCK_HELD';\n`);
 let pending;
 try{
  for(let n=0;n<100&&!output.includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
  assert.ok(output.includes('LOCK_HELD'),errors);
  pending=parallel(confirm(p));let blocked=false;
  for(let n=0;n<100&&!blocked;n++){blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${p.id}%');`)==='t';if(!blocked)await new Promise(r=>setTimeout(r,25));}
  assert.ok(blocked,'confirmation must really wait');
  holder.stdin.end('commit;\n');assert.equal(await closed,0,errors);
  const result=await pending;assert.equal(result.ok,false);assert.match(result.output,expected);
 }finally{if(!holder.stdin.writableEnded)holder.stdin.end('rollback;\n');await closed;if(pending)await pending;}
}
await waitRace("insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'b6500000-0000-4000-8000-000000000001',id,'deny','Race','b6500000-0000-4000-8000-000000000001' from public.permissions where code='costing.calculate'",/ASSISTANT_OPERATION_DENIED/);
run("delete from public.user_permission_overrides where user_id='b6500000-0000-4000-8000-000000000001';");
await waitRace("update public.shipment_items set shipped_quantity=101 where id='b6540000-0000-4000-8000-000000000001'",/ASSISTANT_OPERATION_STALE/);
await waitRace(actor+`select public.calculate_shipment_cost('${shipment}',(select id from public.currencies where code='EUR'))`,/ASSISTANT_OPERATION_STALE/);
assert.equal(run(`select count(*) from public.cost_calculations where shipment_id='${shipment}' and status='draft' and approved_at is null;`),'2');
assert.equal(run(`select count(*) from public.inventory_batches where source_shipment_item_id='b6540000-0000-4000-8000-000000000001' and unit_landed_cost is not null;`),'0');
console.log('PASS assistant costing: permission, quantity and native calculation during real lock waits => refusal; no approval or batch costing');
