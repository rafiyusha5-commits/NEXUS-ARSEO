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
