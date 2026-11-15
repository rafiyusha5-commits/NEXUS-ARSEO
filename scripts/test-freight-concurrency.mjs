import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const [psql,...args]=process.argv.slice(2);
if(!psql)throw Error('Provide psql arguments for an isolated test database');
const user='fc000000-0000-4000-8000-000000000001';
const actor=`set role authenticated;select set_config('request.jwt.claim.sub','${user}',false);`;
function sql(query){const r=spawnSync(psql,[...args,'-At'],{input:query,encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim().split(/\r?\n/).at(-1);}
function call(query){return new Promise(resolve=>{const child=spawn(psql,[...args,'-At'],{windowsHide:true,stdio:['pipe','pipe','pipe']});let out='',error='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>error+=v);child.on('error',e=>resolve({code:1,error:e.message,out}));child.on('close',code=>resolve({code,error,out:out.trim().split(/\r?\n/).at(-1)}));child.stdin.end(query);});}
const fixture=fileURLToPath(new URL('../supabase/tests/fixtures/freight_directory.sql',import.meta.url)).replaceAll('\\','/');
sql(`\\i '${fixture}'`);
const carrier=sql(`${actor}select public.save_freight_directory('carrier',gen_random_uuid(),null,0,'{"counterparty_id":"fc100000-0000-4000-8000-000000000001","active":true}','Concurrency fixture');`);
const driver=`${actor}select public.save_freight_directory('driver','fc700000-0000-4000-8000-000000000001',null,0,'{"full_name":"Concurrent driver","active":true,"carrier_id":"${carrier}"}','Concurrent repeat');`;
const repeated=await Promise.all(Array.from({length:10},()=>call(driver)));
assert.ok(repeated.every(r=>r.code===0));assert.equal(new Set(repeated.map(r=>r.out)).size,1);
assert.equal(sql(`select count(*) from private.freight_directory_history where kind='driver' and entity_id='${repeated[0].out}'`),'1');
const vehicle=(req,id=null,version=0,make='Test')=>`select public.save_freight_directory('vehicle',${req},${id?`'${id}'`:'null'},${version},'{"carrier_id":"${carrier}","plate_number":"RACE-123","registration_country":"KZ","vehicle_type":"truck","status":"active","make":"${make}"}','Concurrent vehicle');`;
const duplicates=await Promise.all(Array.from({length:10},()=>call(actor+vehicle('gen_random_uuid()'))));
assert.equal(duplicates.filter(r=>r.code===0).length,1);assert.ok(duplicates.filter(r=>r.code!==0).every(r=>/уже есть/.test(r.error)));
const id=duplicates.find(r=>r.code===0).out;
const competing=await Promise.all(['A','B'].map(make=>call(actor+vehicle('gen_random_uuid()',id,1,make))));
assert.equal(competing.filter(r=>r.code===0).length,1);assert.match(competing.find(r=>r.code!==0).error,/изменилась/);
const before=sql(`select to_jsonb(v)::text from public.vehicles v where id='${id}'`);
// Real row-lock wait: revoke access in the transaction which releases the lock.
const holder=call(`set application_name='freight-revoke-holder';begin;select 1 from public.vehicles where id='${id}' for update;select pg_sleep(4);update public.user_permission_overrides set effect='deny',reason='Concurrent revocation' where user_id='${user}' and permission_id=(select id from public.permissions where code='carriers.directory.manage');commit;`);
let held=false;
for(let i=0;i<50;i++){held=sql("select exists(select 1 from pg_stat_activity where application_name='freight-revoke-holder' and wait_event='PgSleep')")==='t';if(held)break;await new Promise(r=>setTimeout(r,20));}
assert.ok(held,'holder reached row lock');
const waiting=call("set application_name='freight-revoke-waiter';"+actor+vehicle('gen_random_uuid()',id,2,'Denied'));
let blocked=false;
for(let i=0;i<50;i++){blocked=sql("select exists(select 1 from pg_stat_activity where application_name='freight-revoke-waiter' and wait_event_type='Lock')")==='t';if(blocked)break;await new Promise(r=>setTimeout(r,20));}
assert.ok(blocked,'writer genuinely waited for lock');
const heldResult=await holder;assert.equal(heldResult.code,0,heldResult.error);const denied=await waiting;assert.notEqual(denied.code,0);assert.match(denied.error,/Недостаточно прав/);
assert.equal(sql(`select to_jsonb(v)::text from public.vehicles v where id='${id}'`),before);
sql(`update public.user_permission_overrides set effect='allow' where user_id='${user}' and permission_id=(select id from public.permissions where code='carriers.directory.manage');`);
// Removing a previous operation must lock it too: it can be completed concurrently.
const op1='fc300000-0000-4000-8000-000000000001',op2='fc300000-0000-4000-8000-000000000002';
const values=JSON.stringify({carrier_id:carrier,driver_id:repeated[0].out,vehicle_id:id,pallet_tare_kg:'25',origin:{address:'Test origin',confirmed:true},destination:{address:'Test destination',confirmed:true}});
const preview=ops=>sql(`${actor}select public.preview_freight_trip('sale',array[${ops.map(x=>`'${x}'::uuid`).join(',')}],'${values}')->>'digest'`);
const trip=sql(`${actor}select public.save_freight_trip(gen_random_uuid(),null,0,'sale',array['${op1}'::uuid,'${op2}'::uuid],'${values}','${preview([op1,op2])}','Initial trip')`);
const digest=preview([op2]),tripBefore=sql(`select to_jsonb(t)::text from private.freight_trips t where id='${trip}'`);
const completion=call(`set application_name='freight-operation-holder';begin;select 1 from public.sales where id='${op1}' for update;select pg_sleep(4);set local session_replication_role=replica;update public.sales set status='cancelled' where id='${op1}';commit;`);
held=false;
for(let i=0;i<50;i++){held=sql("select exists(select 1 from pg_stat_activity where application_name='freight-operation-holder' and wait_event='PgSleep')")==='t';if(held)break;await new Promise(r=>setTimeout(r,20));}
assert.ok(held);
const edit=call(`set application_name='freight-operation-waiter';${actor}select public.save_freight_trip(gen_random_uuid(),'${trip}',1,'sale',array['${op2}'::uuid],'${values}','${digest}','Remove previous operation')`);
blocked=false;
for(let i=0;i<50;i++){blocked=sql("select exists(select 1 from pg_stat_activity where application_name='freight-operation-waiter' and wait_event_type='Lock')")==='t';if(blocked)break;await new Promise(r=>setTimeout(r,20));}
assert.ok(blocked,'editing a trip must lock the operation being removed');
assert.equal((await completion).code,0);const refused=await edit;assert.notEqual(refused.code,0);assert.match(refused.error,/недоступен/);
assert.equal(sql(`select to_jsonb(t)::text from private.freight_trips t where id='${trip}'`),tripBefore);
assert.equal(sql(`select count(*) from private.freight_trip_links where trip_id='${trip}'`),'2');
console.log('PASS freight concurrency: 10 idempotent repeats, 10 duplicate identities, conflicting edits, denial during row-lock wait, concurrent completion of removed operation');
