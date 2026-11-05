// Only the disposable PostgreSQL cluster supplied by test-db.sh; no production credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
const [command,...args]=process.argv.slice(2);
if(!command)throw Error('Pass psql and disposable test cluster arguments');
async function run(sql,success=true){
 const result=await new Promise((resolve,reject)=>{
  const p=spawn(command,[...args,'-X','-q','-tA','-v','ON_ERROR_STOP=1'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);
  const timer=setTimeout(()=>p.kill(),25000);
  p.on('error',e=>{clearTimeout(timer);reject(e);});
  p.on('close',code=>{clearTimeout(timer);resolve({code,out:out.trim(),err});});
  p.stdin.end(`set statement_timeout='20s';\n${sql}`);
 });
 if(success)assert.equal(result.code,0,result.err);
 return result;
}
await run(await readFile(new URL('../supabase/tests/fixtures/historical_sales.sql',import.meta.url),'utf8'));
const who="set role authenticated;set request.jwt.claim.sub='af010000-0000-4000-8000-000000000001';";
const create=(request)=>`${who} select public.create_historical_customer_order('${request}','af110000-0000-4000-8000-000000000002',null,'af210000-0000-4000-8000-000000000001',(select d from tests.historical_context where k='day'),(select id from tests.historical_context where k='currency'),'HIST-RACE','Повторная отправка формы',null);`;
async function waitFor(sql){
 for(let n=0;n<100;n++){if((await run(sql)).out==='t')return;await delay(20);}
 throw Error('Concurrent session did not reach the expected lock');
}
const holder=run(`begin;set application_name='historical-create-holder';${create('af610000-0000-4000-8000-000000000001')}select pg_sleep(3);commit;`);
await waitFor("select exists(select 1 from pg_stat_activity where application_name='historical-create-holder' and wait_event='PgSleep')");
const waiters=Array.from({length:9},()=>run(`set application_name='historical-create-waiter';${create('af610000-0000-4000-8000-000000000001')}`));
await waitFor("select exists(select 1 from pg_stat_activity where application_name='historical-create-waiter' and wait_event_type='Lock')");
const repeats=await Promise.all([holder,...waiters]);
assert.equal(new Set(repeats.map(r=>r.out)).size,1);
const sale=repeats[0].out;assert.match(sale,/^[a-f0-9-]{36}$/);
const conflicts=await Promise.all([2,3,4].map(n=>run(create(`af610000-0000-4000-8000-00000000000${n}`),false)));
for(const r of conflicts){assert.notEqual(r.code,0);assert.match(r.err,/уже существует/);}
await run(`${who}
 insert into tests.historical_context values('sale','${sale}',null);
 insert into tests.historical_context values('item',public.add_customer_order_item('${sale}','af310000-0000-4000-8000-000000000001',10,'piece',10,80),null);
 select public.reserve_customer_order_item_fefo(id) from tests.historical_context where k='item';`);
await run("update public.inventory_batches set manufacture_date=private.business_today()-200 where id='af410000-0000-4000-8000-000000000001'");
const token=(await run(`${who}select public.historical_sale_receipt_preview('${sale}')->>'token';`)).out;
const receipt=`${who}select public.record_historical_sale_receipt('${sale}','af710000-0000-4000-8000-000000000001','${token}','Владелец подтвердил фактическую приёмку без письма и согласования',true);`;
const recording=run(`begin;set application_name='historical-receipt-holder';${receipt}select pg_sleep(3);commit;`);
await waitFor("select exists(select 1 from pg_stat_activity where application_name='historical-receipt-holder' and wait_event='PgSleep')");
const recordWaiters=Array.from({length:9},()=>run(`set application_name='historical-receipt-waiter';${receipt}`));
await waitFor("select exists(select 1 from pg_stat_activity where application_name='historical-receipt-waiter' and wait_event_type='Lock')");
const recorded=await Promise.all([recording,...recordWaiters]);
assert.equal(new Set(recorded.map(r=>r.out)).size,1,'same receipt on 10 concurrent retries');
await run(`${who}select public.confirm_customer_order('${sale}');`);
const shipping=run(`begin;set application_name='historical-ship-holder';${who}select public.fulfill_customer_order('${sale}');select pg_sleep(3);commit;`);
await waitFor("select exists(select 1 from pg_stat_activity where application_name='historical-ship-holder' and wait_event='PgSleep')");
const shippingWaiters=Array.from({length:9},()=>run(`set application_name='historical-ship-waiter';${who}select public.fulfill_customer_order('${sale}');`));
await waitFor("select exists(select 1 from pg_stat_activity where application_name='historical-ship-waiter' and wait_event_type='Lock')");
await Promise.all([shipping,...shippingWaiters]);
await run(`do $$begin
 assert (select count(*)=1 from public.sales where historical_reference='HIST-RACE');
 assert (select count(*)=1 from public.historical_sale_receipts where sale_id='${sale}');
 assert not exists(select 1 from public.guarantee_letters where sale_id='${sale}');
 assert (select required_shelf_life_pct=80 from public.sale_items where sale_id='${sale}');
 assert (select count(*)=1 and sum(quantity)=10 from public.inventory_movements where sale_id='${sale}' and movement_type='issue');
 assert (select quantity_on_hand=90 and quantity_reserved=0 from public.inventory_balances where id='af510000-0000-4000-8000-000000000001');
 assert (select status='shipped' and private.business_date(shipped_at)=historical_shipment_date and shipped_recorded_at>shipped_at from public.sales where id='${sale}');
end$$;`);
console.log('historical sales concurrency passed: 10 create retries, 3 duplicate sources, 10 receipt retries, 10 fulfillment retries');
