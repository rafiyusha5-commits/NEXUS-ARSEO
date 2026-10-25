// Disposable PostgreSQL only: revoke access while confirmation waits on a document.
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
const [psql,...args]=process.argv.slice(2);
if(!psql||!args.includes('ON_ERROR_STOP=1'))throw Error('Use isolated SQL runner');
const run=sql=>execFileSync(psql,[...args,'-tA'],{input:sql,encoding:'utf8',windowsHide:true,maxBuffer:8e6}).trim();
const fixture=readFileSync(new URL('../supabase/tests/fixtures/assistant_document_access.sql',import.meta.url),'utf8')
 .replaceAll('\r\n','\n').replaceAll('create temporary table','create table')
 .replace(/\bepm\b/g,'tests.doc_epm').replace(/\bdocument_cases\b/g,'tests.doc_cases');
run(fixture+'\nreset role;commit;');
const actor="set role authenticated;select set_config('request.jwt.claim.sub','f7900000-0000-4000-8000-000000000001',false);";
const cases=JSON.parse(run('select jsonb_agg(to_jsonb(c) order by kind) from tests.doc_cases c;'));
const snapshot=()=>run(`select jsonb_build_object(
 'expenses',(select jsonb_agg(to_jsonb(e) order by id) from public.expenses e),
 'allocations',(select jsonb_agg(to_jsonb(a) order by id) from public.expense_allocations a),
 'costs',(select jsonb_agg(to_jsonb(c) order by id) from public.cost_calculations c),
 'cost_lines',(select jsonb_agg(to_jsonb(c) order by id) from public.cost_calculation_items c),
 'ledger',(select jsonb_agg(to_jsonb(o) order by id) from private.assistant_operations o),
 'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.audit_log a));`);
const start=()=>{
 const child=spawn(psql,[...args,'-tA'],{windowsHide:true});let output='';
 child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
 const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>resolve({code,output}));});
 return {child,done,output:()=>output};
};
for(const c of cases){
 const prepared=run(actor+`select public.prepare_assistant_operation('${c.id}','${c.kind}',(select payload from tests.doc_cases where id='${c.id}'));select public.review_assistant_operation('${c.id}');`);
 const review=JSON.parse(prepared.split('\n').find(line=>line.includes('review_token')));
 const holder=start();let pending;
 holder.child.stdin.write("begin;select 1 from public.documents where id='f0690000-0000-4000-8000-000000000001' for update;select 'LOCK_HELD';\n");
 try{
  for(let n=0;n<200&&!holder.output().includes('LOCK_HELD');n++)await new Promise(r=>setTimeout(r,25));
  assert.ok(holder.output().includes('LOCK_HELD'),holder.output());
  pending=start();pending.child.stdin.end(actor+`select public.confirm_assistant_operation('${c.id}','${review.review_token}');`);
  let blocked=false;
  for(let n=0;n<200&&!blocked;n++){
   blocked=run(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%${c.id}%');`)==='t';
   if(!blocked)await new Promise(r=>setTimeout(r,25));
  }
  assert.ok(blocked,c.kind+' must wait on the document lock before the permission change');
  run("insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select 'f7900000-0000-4000-8000-000000000001',id,'deny','Concurrent hidden document','f7900000-0000-4000-8000-000000000001' from public.permissions where code='templates.generate_prices';");
  const before=snapshot();
  holder.child.stdin.end('commit;\n');assert.equal((await holder.done).code,0);
  const result=await pending.done;
  assert.notEqual(result.code,0,c.kind+' unexpectedly confirmed');
  assert.match(result.output,/ASSISTANT_OPERATION_DENIED/);
  assert.doesNotMatch(result.output,/PRIVATE-PURCHASE-DOCUMENT/);
  assert.equal(snapshot(),before,c.kind+' changed financial rows, receipt or audit after denial');
  console.log('PASS '+c.kind+': hidden-document access revoked during real lock wait => refusal, no mutation');
 }finally{
  if(!holder.child.stdin.writableEnded)holder.child.stdin.end('rollback;\n');
  await holder.done;if(pending)await pending.done;
 }
 run("delete from public.user_permission_overrides where user_id='f7900000-0000-4000-8000-000000000001';");
}
