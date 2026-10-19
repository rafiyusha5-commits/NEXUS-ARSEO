// Called only with the throwaway cluster created by test-db.sh; no env credentials or network.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const [command,...args]=process.argv.slice(2);
if (!command) throw Error('Pass disposable psql arguments');
function start(sql) {
  const child=spawn(command,[...args,'-X','-q','-tA','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
  let stdout='',stderr='',done=false;
  child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill(),15000);
  const result=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>{clearTimeout(timer);done=true;resolve({code,stdout,stderr});});});
  child.stdin.end(`set statement_timeout='10s'; ${sql}`);
  return {result,done:()=>done};
}
async function run(sql) { const r=await start(sql).result;assert.equal(r.code,0,r.stderr);return r.stdout.trim(); }
const who=n=>`set role authenticated; set request.jwt.claim.sub='b9600000-0000-4000-8f78-00000000000${n}';`;
const literal=x=>`'${JSON.stringify(x).replaceAll("'","''")}'::jsonb`;
const sha=s=>createHash('sha256').update(s).digest('hex');
const bank=(file,op)=>({kind:'bank',file_name:`${file}.txt`,file_sha256:sha(file),account:'KZRACE',currency:'KZT',rows:[{
 operation_id:op,identity_source:'bank',doc_number:'1',doc_date:'2026-01-01',amount:100,payer_bin:'990000001078',payer_account:'KZPAYER',purpose:'Synthetic'}]});
const preview=async p=>JSON.parse(await run(`${who(1)} select public.preview_receivables_import(${literal(p)});`));
const confirm=(p,id,v)=>`select public.confirm_receivables_import('${id}',${literal(p)},'${v.fingerprint}');`;
async function race(a,b,secondSucceeds) {
 const va=await preview(a),vb=await preview(b),aid=randomUUID(),bid=randomUUID();
 assert.equal(va.can_confirm,true,JSON.stringify(va)); assert.equal(vb.can_confirm,true,JSON.stringify(vb));
 const first=start(`set application_name='import-race-holder'; begin; ${who(1)} ${confirm(a,aid,va)} select pg_sleep(1.5); commit;`);
 let ready=false;
 for(let i=0;i<100;i++) {ready=(await run("select exists(select 1 from pg_stat_activity where application_name='import-race-holder' and wait_event='PgSleep')"))==='t';if(ready||first.done())break;await delay(20);}
 assert.ok(ready,'first transaction holds import lock');
 const second=start(`${who(2)} ${confirm(b,bid,vb)}`);
 await delay(100);assert.equal(second.done(),false,'competing import must wait');
 const ra=await first.result,rb=await second.result;assert.equal(ra.code,0,ra.stderr);
 if(secondSucceeds) assert.equal(rb.code,0,rb.stderr);else {assert.notEqual(rb.code,0);assert.match(rb.stderr,/изменились|конфликт/);}
 return {id:bid};
}
await run(await readFile(new URL('../supabase/tests/fixtures/receivables_import_concurrency.sql',import.meta.url),'utf8'));
await race(bank('same','A'),{...bank('same','A'),file_name:'renamed.txt'},true);
assert.equal(await run("select count(*) from public.bank_statement_lines l join public.bank_statement_imports i on i.id=l.import_id where i.account_number='KZRACE'"),'1');
const overlap=bank('overlap-b','B');
const retry=await race(bank('overlap-a','B'),overlap,false);
const updated=await preview(overlap);assert.equal(updated.rows[0].status,'duplicate');
await run(`${who(2)} ${confirm(overlap,retry.id,updated)}`);
await race(bank('different-a','C'),bank('different-b','D'),true);
assert.equal(await run("select count(*) from public.bank_statement_lines l join public.bank_statement_imports i on i.id=l.import_id where i.account_number='KZRACE'"),'4');
const opening=file=>({kind:'opening',file_name:`${file}.csv`,file_sha256:sha(file),as_of:'2026-01-01',rows:[{name:'Import Race Synthetic',bin:'990000001078',currency:'KZT',amount:500}]});
await race(opening('balance-a'),opening('balance-b'),false);
assert.equal(await run("select count(*) from public.customer_opening_balances where customer_id='b9700000-0000-4000-8f78-000000000001'"),'1');
const currentBalance = async () => run("select id from public.customer_opening_balances where customer_id='b9700000-0000-4000-8f78-000000000001' and superseded_at is null");
let oldId = await currentBalance();
const corrected = {...opening('balance-a'), as_of:'2026-01-02'};
corrected.rows = corrected.rows.map(row=>({...row,replace_id:oldId,reason:'Correct original date after source review'}));
await race(corrected,{...corrected,file_name:'renamed-correction.csv'},true);
assert.equal(await run("select count(*) from public.customer_opening_balances where customer_id='b9700000-0000-4000-8f78-000000000001'"),'2','concurrent retries created one revision');
oldId = await currentBalance();
const next = {...corrected,as_of:'2026-01-03',rows:corrected.rows.map(row=>({...row,replace_id:oldId,reason:'Second reviewed correction'}))};
await race(next,{...next,as_of:'2026-01-04'},false);
assert.equal(await run("select count(*) from public.customer_opening_balances where customer_id='b9700000-0000-4000-8f78-000000000001'"),'3','losing correction wrote nothing');
console.log('receivables concurrency: retries, overlapping operations, opening conflict, same-file corrections and competing revisions passed');
