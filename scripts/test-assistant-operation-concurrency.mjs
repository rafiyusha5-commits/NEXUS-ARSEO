// Called only by the disposable PostgreSQL test runner. Uses synthetic fixture IDs.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const [psql,...args]=process.argv.slice(2);
if (!psql || !args.includes('ON_ERROR_STOP=1')) throw Error('Use the isolated SQL test runner');
const quote=value=>`'${String(value).replaceAll("'","''")}'`;
const run=sql=>execFileSync(psql,[...args,'-tA'],{input:sql,encoding:'utf8',windowsHide:true,maxBuffer:4e6}).trim();
const parallel=sql=>new Promise(resolve=>{
 const child=spawn(psql,[...args,'-tA'],{windowsHide:true});let output='';
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 child.on('error',error=>resolve({ok:false,output:String(error)}));child.on('close',code=>resolve({ok:code===0,output}));child.stdin.end(sql);
});
const fixture=readFileSync(fileURLToPath(new URL('../supabase/tests/assistant_operations.test.sql',import.meta.url)),'utf8').replaceAll('\r\n','\n').split('set local role authenticated;')[0];
const payload=JSON.parse(run(fixture+'\nselect payload::text from ao;\ncommit;').split('\n').find(x=>x.startsWith('{')));
const actor=user=>`set role authenticated;select set_config('request.jwt.claim.sub',${quote(user)},false);`;
const user='af000000-0000-4000-8000-000000000001';
const prepare=(id,who,p)=>{
 const out=run(actor(who)+`select public.prepare_assistant_operation(${quote(id)},'inventory_transfer',${quote(JSON.stringify(p))}::jsonb);select public.review_assistant_operation(${quote(id)});`);
 return JSON.parse(out.split('\n').find(x=>x.includes('review_token')));
};
const id='af000000-0000-4000-8000-000000000061';const review=prepare(id,user,payload);
const results=await Promise.all(Array.from({length:12},()=>parallel(actor(user)+`select public.confirm_assistant_operation(${quote(id)},${quote(review.review_token)});`)));
if(results.some(r=>!r.ok))throw Error('Same-request replay failed: '+JSON.stringify(results));
const documents=new Set(results.map(r=>JSON.parse(r.output.split('\n').find(x=>x.includes('result_id'))).result_id));
if(documents.size!==1)throw Error('Duplicate operation documents');
const a='af000000-0000-4000-8000-000000000062',b='af000000-0000-4000-8000-000000000063';
const other='af000000-0000-4000-8000-000000000002';
const one={...payload,quantity:'1'};
const ra=prepare(a,user,one),rb=prepare(b,other,one);
const race=await Promise.all([[a,user,ra],[b,other,rb]].map(([key,who,r])=>parallel(actor(who)+`select public.confirm_assistant_operation(${quote(key)},${quote(r.review_token)});`)));
if(race.filter(r=>r.ok).length!==1 || !race.some(r=>/ASSISTANT_OPERATION_(STOCK|STALE)/.test(r.output)))throw Error('Last-stock race failed: '+JSON.stringify(race));
run(`do $$begin
 assert (select count(*)=2 from private.assistant_operations where id in ('${id}','${a}','${b}') and result_id is not null),'exactly two completed operations';
 assert (select sum(quantity_on_hand)=36 from public.inventory_balances where batch_id in ('af000000-0000-4000-8000-000000000031','af000000-0000-4000-8000-000000000032')),'stock conserved';
end$$;`);
console.log('PASS assistant: 12 concurrent retries => one document; two employees competing => one winner; stock conserved');

// Reuse the existing order fixture, with a separate synthetic namespace from the standard fulfillment race.
const orderFixture=readFileSync(fileURLToPath(new URL('../supabase/tests/fixtures/order_fulfillment.sql',import.meta.url)),'utf8')
 .replaceAll('\r\n','\n').replace(/ef([0-9a-f]{6})-0000-/g,'ed$1-8a21-').replaceAll('fulfillment_context','assistant_order_context')
 .replaceAll('SYNTH-FF','SYNTH-AOFF').replaceAll('fulfillment@example.invalid','assistant-fulfillment@example.invalid');
run(orderFixture);
const orderUser='ed000000-8a21-4000-8000-000000000001';
const orderPrepare=(key,which)=>{
 const out=run(actor(orderUser)+`select public.prepare_assistant_operation('${key}','customer_order_fulfillment',jsonb_build_object('sale_id',id)) from tests.assistant_order_context where k='${which}';select public.review_assistant_operation('${key}');`);
 return JSON.parse(out.split('\n').find(x=>x.includes('review_token')));
};
const key='ed000000-8a21-4000-8000-000000000061',orderReview=orderPrepare(key,'sale');
const orderResults=await Promise.all(Array.from({length:8},()=>parallel(actor(orderUser)+`select public.confirm_assistant_operation('${key}','${orderReview.review_token}');`)));
if(orderResults.some(r=>!r.ok))throw Error('Order replay failed: '+JSON.stringify(orderResults));
const distinctA='ed000000-8a21-4000-8000-000000000062',distinctB='ed000000-8a21-4000-8000-000000000063';
const da=orderPrepare(distinctA,'other'),db=orderPrepare(distinctB,'other');
const distinctRace=await Promise.all([[distinctA,da],[distinctB,db]].map(([k,r])=>parallel(actor(orderUser)+`select public.confirm_assistant_operation('${k}','${r.review_token}');`)));
if(distinctRace.filter(r=>r.ok).length!==1||!distinctRace.some(r=>r.output.includes('ASSISTANT_OPERATION_ORDER_STATE')))throw Error('Two proposals for one order: '+JSON.stringify(distinctRace));
run(`do $$begin
 assert (select count(*)=2 and sum(quantity)=150 from public.inventory_movements where sale_id=(select id from tests.assistant_order_context where k='sale'));
 assert (select count(*)=1 and sum(quantity)=50 from public.inventory_movements where sale_id=(select id from tests.assistant_order_context where k='other'));
 assert (select sum(quantity_on_hand)=100 and sum(quantity_reserved)=0 from public.inventory_balances where warehouse_id='ed200000-8a21-4000-8000-000000000001');
 assert (select count(*)=2 from private.assistant_operations where id in ('${key}','${distinctA}','${distinctB}') and result_sale_id is not null);
end$$;`);
console.log('PASS assistant order: 8 concurrent retries => one fulfillment; two proposals => one winner; exact movements/reserves');

run(actor(orderUser)+`insert into tests.assistant_order_context values('waiting',public.create_customer_order('ed100000-8a21-4000-8000-000000000002',null,'ed200000-8a21-4000-8000-000000000001','2099-01-20',null,'Synthetic waiting order'));
 insert into tests.assistant_order_context select 'waiting-item',public.add_customer_order_item(id,'ed300000-8a21-4000-8000-000000000001',10,'piece',null,60) from tests.assistant_order_context where k='waiting';
 select public.reserve_customer_order_item_fefo(id) from tests.assistant_order_context where k='waiting-item';
 select public.confirm_customer_order(id) from tests.assistant_order_context where k='waiting';`);
// A real second PostgreSQL session holds a lock. Wait until the confirmation is actually blocked,
// then commit the changed authority/source; do not rely on a scheduling guess or mocked race.
async function whileWaiting(key,heldSql,expected,preparePreview=()=>orderPrepare(key,'waiting'),who=orderUser,expire=false){
 const preview=preparePreview();
 if(expire)run(`update private.assistant_operations set expires_at=clock_timestamp()+interval '5 seconds' where id='${key}';`);
 const holder=spawn(psql,[...args,'-tA'],{windowsHide:true});let stdout='',stderr='';
 const closed=new Promise(resolve=>holder.on('close',code=>resolve(code)));
 holder.stdout.on('data',d=>stdout+=d);holder.stderr.on('data',d=>stderr+=d);
 holder.stdin.write(`begin;${heldSql};select 'SYNTH_LOCK_HELD';\n`);
 let confirmation;
 try{
  for(let i=0;i<100&&!stdout.includes('SYNTH_LOCK_HELD');i++)await new Promise(r=>setTimeout(r,25));
  if(!stdout.includes('SYNTH_LOCK_HELD'))throw Error('Holder did not acquire lock: '+stderr);
  confirmation=parallel(actor(who)+`select public.confirm_assistant_operation('${key}','${preview.review_token}');`);
  let waiting=false;
  for(let i=0;i<100&&!waiting;i++){
   waiting=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${key}%');`)==='t';
   if(!waiting)await new Promise(r=>setTimeout(r,25));
  }
  if(!waiting)throw Error('Confirmation never waited for the lock');
  if(expire){
   let expired=false;
   for(let i=0;i<300&&!expired;i++){
    expired=run(`select clock_timestamp()>expires_at from private.assistant_operations where id='${key}';`)==='t';
    if(!expired)await new Promise(r=>setTimeout(r,25));
   }
   if(!expired)throw Error('Synthetic confirmation deadline did not elapse');
  }
  holder.stdin.end('commit;\n');if(await closed!==0)throw Error(stderr);
  const result=await confirmation;
  if(result.ok||!result.output.includes(expected))throw Error('Expected refusal after lock wait: '+JSON.stringify(result));
 }finally{
  if(!holder.stdin.writableEnded)holder.stdin.end('rollback;\n');
  await closed;if(confirmation)await confirmation;
 }
}
// Compare all affected business rows, not just the exception or receipt.
const businessSnapshot=()=>run(`select jsonb_build_object(
 'sales',(select jsonb_agg(to_jsonb(t) order by id) from public.sales t),
 'items',(select jsonb_agg(to_jsonb(t) order by id) from public.sale_items t),
 'balances',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_balances t),
 'reservations',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_reservations t),
 'movements',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_movements t),
 'documents',(select jsonb_agg(to_jsonb(t) order by id) from public.inventory_operation_documents t)
 );`);
async function expiryRace(key,heldSql,preparePreview,who){
 const before=businessSnapshot();
 await whileWaiting(key,heldSql,'ASSISTANT_OPERATION_EXPIRED',preparePreview,who,true);
 if(businessSnapshot()!==before)throw Error('Expired confirmation changed business rows');
 if(run(`select confirmed_at is null and result_id is null and result_sale_id is null from private.assistant_operations where id='${key}';`)!=='t')throw Error('Expired confirmation recorded success');
 console.log('PASS assistant deadline after actual lock wait: '+key);
}
const transferExpiry='af000000-0000-4000-8000-000000000090';
await expiryRace(transferExpiry,`select 1 from public.inventory_balances order by id for update`,
 ()=>prepare(transferExpiry,user,{...payload,from_warehouse_id:payload.to_warehouse_id,to_warehouse_id:payload.from_warehouse_id,quantity:'1'}),user);
const orderExpiry='ed000000-8a21-4000-8000-000000000090';
await expiryRace(orderExpiry,`select 1 from public.sales where id=(select id from tests.assistant_order_context where k='waiting') for update`,
 ()=>orderPrepare(orderExpiry,'waiting'),orderUser);
await whileWaiting('ed000000-8a21-4000-8000-000000000064',`update public.inventory_batches set status='blocked' where id='ed400000-8a21-4000-8000-000000000002'`,'ASSISTANT_OPERATION_ORDER_BLOCKED');
run(`update public.inventory_batches set status='available' where id='ed400000-8a21-4000-8000-000000000002';`);
await whileWaiting('ed000000-8a21-4000-8000-000000000065',`select 1 from public.sales where id=(select id from tests.assistant_order_context where k='waiting') for update;
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select '${orderUser}',id,'deny','Synthetic concurrent denial','${orderUser}' from public.permissions where code='sales.manage'`,'ASSISTANT_OPERATION_DENIED');
run(`do $$begin
 assert (select status='confirmed' and shipped_at is null from public.sales where id=(select id from tests.assistant_order_context where k='waiting'));
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.assistant_order_context where k='waiting'));
 assert (select sum(quantity_on_hand)=100 and sum(quantity_reserved)=10 from public.inventory_balances where warehouse_id='ed200000-8a21-4000-8000-000000000001');
end$$;`);
console.log('PASS assistant order: batch block and personal deny committed during actual lock wait => refusal, no issue');

// Draft creation uses the same receipt and existing sales RPCs; no stock business rules here.
run(readFileSync(fileURLToPath(new URL('../supabase/tests/fixtures/assistant_order_creation.sql',import.meta.url)),'utf8').replaceAll('\r\n','\n'));
const draftUser='ad000000-8a22-4000-8000-000000000001',draftKey='ad000000-8a22-4000-8000-000000000061';
const draftPrepare=key=>{
 const out=run(actor(draftUser)+`select public.prepare_assistant_operation('${key}','customer_order_create',payload) from tests.assistant_draft_context;select public.review_assistant_operation('${key}');`);
 return JSON.parse(out.split('\n').find(x=>x.includes('review_token')));
};
const preparing=await Promise.all(Array.from({length:8},()=>parallel(actor(draftUser)+`select public.prepare_assistant_operation('${draftKey}','customer_order_create',payload) from tests.assistant_draft_context;`)));
if(preparing.some(r=>!r.ok))throw Error('Draft concurrent preparation: '+JSON.stringify(preparing));
const draftReview=draftPrepare(draftKey);
// Reapplying only the new migration preserves an awaiting review and its token.
run(readFileSync(fileURLToPath(new URL('../supabase/migrations/202610230500_assistant_order_confirmation.sql',import.meta.url)),'utf8').replaceAll('\r\n','\n'));
if(draftPrepare(draftKey).review_token!==draftReview.review_token)throw Error('Migration lost review receipt');
const drafts=await Promise.all(Array.from({length:12},()=>parallel(actor(draftUser)+`select public.confirm_assistant_operation('${draftKey}','${draftReview.review_token}');`)));
if(drafts.some(r=>!r.ok))throw Error('Concurrent draft retry: '+JSON.stringify(drafts));
const draftIds=new Set(drafts.map(r=>JSON.parse(r.output.split('\n').find(x=>x.includes('result_id'))).result_id));
if(draftIds.size!==1)throw Error('Duplicate draft orders');
run(`do $$begin
 assert (select count(*)=1 and bool_and(status='draft') from public.sales where customer_id='ad000000-8a22-4000-8000-000000000011');
 assert (select count(*)=2 from public.sale_items where sale_id='${[...draftIds][0]}');
 assert not exists(select 1 from public.inventory_movements where sale_id='${[...draftIds][0]}');
 assert not exists(select 1 from private.customer_ledger('ad000000-8a22-4000-8000-000000000011'));
end$$;`);
const staleDraft='ad000000-8a22-4000-8000-000000000062';
const draftExpiry='ad000000-8a22-4000-8000-000000000090';
await expiryRace(draftExpiry,"select 1 from public.products where id='ad000000-8a22-4000-8000-000000000021' for update",()=>draftPrepare(draftExpiry),draftUser);
await whileWaiting(staleDraft,`update public.counterparties set min_remaining_shelf_life_pct=80 where id='ad000000-8a22-4000-8000-000000000011'`,
 'ASSISTANT_OPERATION_STALE',()=>draftPrepare(staleDraft),draftUser);
const deniedDraft='ad000000-8a22-4000-8000-000000000063';
await whileWaiting(deniedDraft,`select 1 from public.products where id='ad000000-8a22-4000-8000-000000000021' for update;
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select '${draftUser}',id,'deny','Synthetic concurrent draft denial','${draftUser}' from public.permissions where code='sales.manage'`,
 'ASSISTANT_OPERATION_DENIED',()=>draftPrepare(deniedDraft),draftUser);
run(`do $$begin
 assert (select count(*)=1 from public.sales where customer_id='ad000000-8a22-4000-8000-000000000011');
 assert not exists(select 1 from private.assistant_operations where id in ('${staleDraft}','${deniedDraft}') and result_sale_id is not null);
end$$;`);
console.log('PASS assistant draft: 8 concurrent prepares, 12 confirmations => one draft; migration replay preserves token; actual lock-wait source/deny races refuse');

run(readFileSync(fileURLToPath(new URL('../supabase/tests/fixtures/assistant_reservation.sql',import.meta.url)),'utf8').replaceAll('\r\n','\n'));
const reserveUser='eb000000-8a23-4000-8000-000000000001',reserveKey='eb000000-8a23-4000-8000-000000000061';
const reservePrepare=(key,which='sale')=>{
 const output=run(actor(reserveUser)+`select public.prepare_assistant_operation('${key}','customer_order_reserve',jsonb_build_object('sale_id',id)) from tests.assistant_reserve_context where k='${which}';select public.review_assistant_operation('${key}');`);
 return JSON.parse(output.split('\n').find(x=>x.includes('review_token')));
};
const reserveReview=reservePrepare(reserveKey);
run(readFileSync(fileURLToPath(new URL('../supabase/migrations/202610230500_assistant_order_confirmation.sql',import.meta.url)),'utf8').replaceAll('\r\n','\n'));
const reserved=await Promise.all(Array.from({length:12},()=>parallel(actor(reserveUser)+`select public.confirm_assistant_operation('${reserveKey}','${reserveReview.review_token}');`)));
if(reserved.some(r=>!r.ok))throw Error('Reservation replay: '+JSON.stringify(reserved));
run(`do $$begin
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='eb200000-8a23-4000-8000-000000000001');
 assert (select count(*)=${reserveReview.preview.lines.length} from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id=(select id from tests.assistant_reserve_context where k='sale') and r.status='active');
end$$;`);
for(const which of ['a','b','waiting','overlap'])run(actor(reserveUser)+`insert into tests.assistant_reserve_context values('${which}',public.create_customer_order('eb100000-8a23-4000-8000-000000000002',null,'eb200000-8a23-4000-8000-000000000001','2099-01-20',null,null));
select public.add_customer_order_item(id,'eb300000-8a23-4000-8000-000000000001',100,'piece',null,60) from tests.assistant_reserve_context where k='${which}';`);
const reserveA='eb000000-8a23-4000-8000-000000000062',reserveB='eb000000-8a23-4000-8000-000000000063';
const aPreview=reservePrepare(reserveA,'a'),bPreview=reservePrepare(reserveB,'b');
const reserveRace=await Promise.all([[reserveA,aPreview],[reserveB,bPreview]].map(([key,r])=>parallel(actor(reserveUser)+`select public.confirm_assistant_operation('${key}','${r.review_token}');`)));
if(reserveRace.filter(r=>r.ok).length!==1||!reserveRace.some(r=>/ASSISTANT_OPERATION_(RESERVE_BLOCKED|STALE)/.test(r.output)))throw Error('Last reservation stock: '+JSON.stringify(reserveRace));
run(actor(reserveUser)+`select public.cancel_customer_order(id,'Synthetic race cleanup') from tests.assistant_reserve_context where k in ('sale','a','b');`);
const overlapKeys=['eb000000-8a23-4000-8000-000000000066','eb000000-8a23-4000-8000-000000000067'];
const overlapPreviews=overlapKeys.map(key=>reservePrepare(key,'overlap'));
const overlap=await Promise.all(overlapKeys.map((key,i)=>parallel(actor(reserveUser)+`select public.confirm_assistant_operation('${key}','${overlapPreviews[i].review_token}');`)));
if(overlap.filter(r=>r.ok).length!==1||!overlap.some(r=>r.output.includes('ASSISTANT_OPERATION_RESERVE_STATE')))throw Error('Two tabs/order: '+JSON.stringify(overlap));
run(actor(reserveUser)+`select public.cancel_customer_order(id,'Synthetic overlap cleanup') from tests.assistant_reserve_context where k='overlap';`);
const waitingReserve='eb000000-8a23-4000-8000-000000000064';
const reserveExpiry='eb000000-8a23-4000-8000-000000000090';
await expiryRace(reserveExpiry,`select 1 from public.sales where id=(select id from tests.assistant_reserve_context where k='waiting') for update`,
 ()=>reservePrepare(reserveExpiry,'waiting'),reserveUser);
await whileWaiting(waitingReserve,`update public.inventory_batches set status='blocked' where id='eb400000-8a23-4000-8000-000000000001'`,
 'ASSISTANT_OPERATION_STALE',()=>reservePrepare(waitingReserve,'waiting'),reserveUser);
run(`update public.inventory_batches set status='available' where id='eb400000-8a23-4000-8000-000000000001';`);
const deniedReserve='eb000000-8a23-4000-8000-000000000065';
await whileWaiting(deniedReserve,`select 1 from public.sales where id=(select id from tests.assistant_reserve_context where k='waiting') for update;
insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select '${reserveUser}',id,'deny','Synthetic reserve denial','${reserveUser}' from public.permissions where code='sales.reserve'`,
 'ASSISTANT_OPERATION_DENIED',()=>reservePrepare(deniedReserve,'waiting'),reserveUser);
run(`do $$begin
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=0 from public.inventory_balances where warehouse_id='eb200000-8a23-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_movements where sale_id in (select id from tests.assistant_reserve_context));
end$$;`);
console.log('PASS assistant reserve: 12 retries, last-stock race, batch block and personal deny during real lock wait; no movements');

// Confirmation: same existing reservation fixture, isolated namespace and normal letter workflow.
run(readFileSync(fileURLToPath(new URL('../supabase/tests/fixtures/assistant_reservation.sql',import.meta.url)),'utf8')
 .replaceAll('\r\n','\n').replaceAll('eb','ec').replaceAll('reserve@example.invalid','confirmation@example.invalid').replaceAll('SYNTH-AR','SYNTH-AC').replaceAll('assistant_reserve_context','assistant_confirmation_context'));
const confirmUser='ec000000-8a23-4000-8000-000000000001',confirmKey='ec000000-8a23-4000-8000-000000000081';
run(actor(confirmUser)+`select public.reserve_customer_order_item_fefo(id) from public.sale_items where sale_id=(select id from tests.assistant_confirmation_context where k='sale') order by id;
 insert into tests.assistant_confirmation_context select 'letter',public.create_sale_guarantee_letter(id,'Synthetic confirmation') from tests.assistant_confirmation_context where k='sale';
 select public.change_sale_guarantee_status(id,'approved') from tests.assistant_confirmation_context where k='letter';`);
const confirmPrepare=(key,which='sale')=>{
 const output=run(actor(confirmUser)+`select public.prepare_assistant_operation('${key}','customer_order_confirm',jsonb_build_object('sale_id',id)) from tests.assistant_confirmation_context where k='${which}';select public.review_assistant_operation('${key}');`);
 return JSON.parse(output.split('\n').find(x=>x.includes('review_token')));
};
const confirmReview=confirmPrepare(confirmKey);
run(readFileSync(fileURLToPath(new URL('../supabase/migrations/202610230500_assistant_order_confirmation.sql',import.meta.url)),'utf8').replaceAll('\r\n','\n'));
if(confirmPrepare(confirmKey).review_token!==confirmReview.review_token)throw Error('Confirmation token changed after migration replay');
const confirmed=await Promise.all(Array.from({length:12},()=>parallel(actor(confirmUser)+`select public.confirm_assistant_operation('${confirmKey}','${confirmReview.review_token}');`)));
if(confirmed.some(r=>!r.ok))throw Error('Confirmation replay: '+JSON.stringify(confirmed));
run(`do $$begin
 assert (select status='confirmed' and confirmed_by='${confirmUser}' and shipped_at is null from public.sales where id=(select id from tests.assistant_confirmation_context where k='sale'));
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='ec200000-8a23-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_movements where sale_id=(select id from tests.assistant_confirmation_context where k='sale'));
end$$;`);
run(actor(confirmUser)+`insert into tests.assistant_confirmation_context values('waiting',public.create_customer_order('ec100000-8a23-4000-8000-000000000002',null,'ec200000-8a23-4000-8000-000000000001','2099-01-20',null,null));
 select public.add_customer_order_item(id,'ec300000-8a23-4000-8000-000000000001',10,'piece',null,60) from tests.assistant_confirmation_context where k='waiting';
 select public.reserve_customer_order_item_fefo(id) from public.sale_items where sale_id=(select id from tests.assistant_confirmation_context where k='waiting');
 do $$declare letter uuid;begin
  if exists(select 1 from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id
   where i.sale_id=(select id from tests.assistant_confirmation_context where k='waiting') and r.status='active' and r.remaining_shelf_life_pct<i.required_shelf_life_pct) then
   letter:=public.create_sale_guarantee_letter((select id from tests.assistant_confirmation_context where k='waiting'),'Synthetic remaining FEFO pieces');
   perform public.change_sale_guarantee_status(letter,'approved');
  end if;
 end $$;`);
const cfBlocked='ec000000-8a23-4000-8000-000000000082';
const confirmExpiry='ec000000-8a23-4000-8000-000000000090';
await expiryRace(confirmExpiry,`select 1 from public.sales where id=(select id from tests.assistant_confirmation_context where k='waiting') for update`,
 ()=>confirmPrepare(confirmExpiry,'waiting'),confirmUser);
await whileWaiting(cfBlocked,`update public.inventory_batches set status='blocked' where id='ec400000-8a23-4000-8000-000000000002'`,
 'ASSISTANT_OPERATION_CONFIRM_BLOCKED',()=>confirmPrepare(cfBlocked,'waiting'),confirmUser);
run(`update public.inventory_batches set status='available' where id='ec400000-8a23-4000-8000-000000000002';`);
const cfDenied='ec000000-8a23-4000-8000-000000000083';
await whileWaiting(cfDenied,`select 1 from public.sales where id=(select id from tests.assistant_confirmation_context where k='waiting') for update;
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select '${confirmUser}',id,'deny','Synthetic confirm denial','${confirmUser}' from public.permissions where code='sales.manage'`,
 'ASSISTANT_OPERATION_DENIED',()=>confirmPrepare(cfDenied,'waiting'),confirmUser);
run(`delete from public.user_permission_overrides where user_id='${confirmUser}';`);
const cfCancel='ec000000-8a23-4000-8000-000000000084';
await whileWaiting(cfCancel,`${actor(confirmUser)} select public.cancel_customer_order(id,'Synthetic cancel during confirmation') from tests.assistant_confirmation_context where k='waiting'`,
 'ASSISTANT_OPERATION_CONFIRM_STATE',()=>confirmPrepare(cfCancel,'waiting'),confirmUser);
run(`do $$begin
 assert (select status='cancelled' from public.sales where id=(select id from tests.assistant_confirmation_context where k='waiting'));
 assert (select sum(quantity_on_hand)=300 and sum(quantity_reserved)=200 from public.inventory_balances where warehouse_id='ec200000-8a23-4000-8000-000000000001');
 assert not exists(select 1 from public.inventory_movements where sale_id in(select id from tests.assistant_confirmation_context));
end$$;`);
run(actor(confirmUser)+`select public.return_customer_order_to_preparation(id,'Synthetic re-confirmation') from tests.assistant_confirmation_context where k='sale';
 insert into tests.assistant_confirmation_context select 'new-letter',public.create_sale_guarantee_letter(id,'Synthetic reapproval') from tests.assistant_confirmation_context where k='sale';
 select public.change_sale_guarantee_status(id,'approved') from tests.assistant_confirmation_context where k='new-letter';`);
const cfLetter='ec000000-8a23-4000-8000-000000000085';
await whileWaiting(cfLetter,`update public.guarantee_letters set status='cancelled' where id=(select id from tests.assistant_confirmation_context where k='new-letter')`,
 'ASSISTANT_OPERATION_CONFIRM_BLOCKED',()=>confirmPrepare(cfLetter),confirmUser);
run(`update public.guarantee_letters set status='approved' where id=(select id from tests.assistant_confirmation_context where k='new-letter');`);
const cfTabs=['ec000000-8a23-4000-8000-000000000086','ec000000-8a23-4000-8000-000000000087'];
const cfTabPreviews=cfTabs.map(key=>confirmPrepare(key));
const cfTabResults=await Promise.all(cfTabs.map((key,i)=>parallel(actor(confirmUser)+`select public.confirm_assistant_operation('${key}','${cfTabPreviews[i].review_token}');`)));
if(cfTabResults.filter(r=>r.ok).length!==1||!cfTabResults.some(r=>r.output.includes('ASSISTANT_OPERATION_CONFIRM_STATE')))throw Error('Two confirmation tabs: '+JSON.stringify(cfTabResults));
console.log('PASS assistant confirmation: 12 retries, two tabs, migration replay; batch block, letter revoke, personal deny and cancellation during actual lock wait, no issue');
