// Real Next server + disposable local Supabase Auth/PostgREST/Storage.
// No remote project arguments, owner env files, auth bypass or SQL business-operation shortcuts.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {randomUUID, generateKeyPairSync, createHash} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, createWriteStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve, join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {runHistoricalForms} from '../tests/pilot/historical-forms.mjs';
import {makeExternalFixtures} from '../tests/pilot/external-fixtures.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
assert.equal(process.argv.length,2,'No database URLs or external endpoints accepted');
const work=mkdtempSync(join(tmpdir(),'nexus-historical-'));
const project='nexus-e2e-'+randomUUID().slice(0,8);
const output=join(root,'test-results/historical');
mkdirSync(output,{recursive:true});
const app=join(work,'app'), stack=join(work,'stack');
mkdirSync(app);mkdirSync(stack);
const hostEnv=Object.fromEntries(Object.entries(process.env).filter(([k])=>/^(PATH|HOME|USERPROFILE|SystemRoot|TEMP|TMP|DOCKER_HOST|DOCKER_CONFIG|CI|RUNNER_TEMP|LANG|LC_ALL)$/i.test(k)));
const cliEnv={...hostEnv, SUPABASE_TELEMETRY_DISABLED:'true'};
function command(bin,args,options={}){
  const r=spawnSync(bin,args,{encoding:'utf8',maxBuffer:32*1024*1024,timeout:600000,windowsHide:true,env:cliEnv,...options});
  if(r.status!==0)throw new Error(`${bin} ${args.slice(0,2).join(' ')} failed: ${(r.stderr||r.stdout||r.error?.message||'').slice(-10000)}`);
  return r.stdout;
}
const cli=args=>command('supabase',['--workdir',stack,...args]);
let started=false, server, log;
try{
  cli(['init','--yes']);
  const config=join(stack,'supabase/config.toml');
  let toml=readFileSync(config,'utf8').replace(/^project_id = .*$/m,`project_id = "${project}"`);
  toml=toml.replace(/^site_url = .*$/m,'site_url = "http://127.0.0.1:3100"');
  toml=toml.replace(/^additional_redirect_urls = .*$/m,'additional_redirect_urls = ["http://127.0.0.1:3100/auth/callback"]');
  toml=toml.replace(/(\[db.seed\][\s\S]*?enabled = )true/,'$1false');
  writeFileSync(config,toml);
  cpSync(join(root,'supabase/migrations'),join(stack,'supabase/migrations'),{recursive:true});
  console.log('Starting a new isolated Supabase stack',project);
  started=true;
  cli(['start','--exclude','studio,imgproxy,realtime,edge-runtime,logflare,vector,supavisor']);
  const keys=JSON.parse(cli(['status','-o','json']));
  const api=new URL(keys.API_URL), db=new URL(keys.DB_URL);
  assert.ok(['127.0.0.1','localhost'].includes(api.hostname)&&api.port==='54321');
  assert.ok(['127.0.0.1','localhost'].includes(db.hostname)&&db.port==='54322');
  const sql=text=>command('docker',['exec','-i',`supabase_db_${project}`,'psql','-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:text});
  const version=sql('show server_version;').trim();
  console.log('Isolated real HTTP backend ready; PostgreSQL',version);
  const email='historical-pilot@example.invalid', password='Synthetic-'+randomUUID()+'!';
  const created=await fetch(new URL('/auth/v1/admin/users',api),{method:'POST',headers:{apikey:keys.SERVICE_ROLE_KEY,Authorization:`Bearer ${keys.SERVICE_ROLE_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({email,password,email_confirm:true,user_metadata:{full_name:'Synthetic Browser Director'}})});
  const user=await created.json();
  assert.ok(created.ok,JSON.stringify(user));
  assert.match(user.id,/^[0-9a-f-]{36}$/);
  const gateway='a'.repeat(64);
  sql(`insert into public.user_roles(user_id,role_id) select '${user.id}',id from public.app_roles where code='director';
    insert into private.drive_gateway_config(id,secret_sha256) values(true,'${createHash('sha256').update(gateway).digest('hex')}') on conflict(id) do update set secret_sha256=excluded.secret_sha256;`);
  sql(readFileSync(join(root,'tests/pilot/browser-reference-seed.sql'),'utf8'));
  const refs=JSON.parse(sql(`select jsonb_build_object('user','${user.id}','eur',(select id from public.currencies where code='EUR'),
    'supplier',(select id from public.counterparties where tax_id='BROWSER-FACTORY'),
    'customer',(select id from public.counterparties where tax_id='BROWSER-BUYER'),
    'route',(select id from public.routes where name->>'en'='Browser Route'),
    'warehouse',(select id from public.warehouses where code='BROWSER-A'),
    'warehouse2',(select id from public.warehouses where code='BROWSER-B'),
    'a',(select id from public.products where internal_sku='BROWSER-A'),
    'b',(select id from public.products where internal_sku='BROWSER-B'));`));
  const fixtures=makeExternalFixtures();
  const fixturesPath=join(work,'external.json');writeFileSync(fixturesPath,JSON.stringify(fixtures));
  // Only tracked application files; env and generated files can never be copied.
  const files=command('git',['ls-files','-z'],{cwd:root}).split('\0').filter(Boolean);
  for(const file of files){
    if(file.startsWith('.env')||file.startsWith('test-results/')||file.startsWith('.git/'))continue;
    const target=join(app,file);mkdirSync(dirname(target),{recursive:true});cpSync(join(root,file),target);
  }
  symlinkSync(join(root,'node_modules'),join(app,'node_modules'),process.platform==='win32'?'junction':'dir');
  const env={...hostEnv,NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',NEXT_PUBLIC_SUPABASE_URL:api.origin,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:keys.ANON_KEY,APP_ORIGIN:'http://127.0.0.1:3100',
    DRIVE_CATALOG_GATEWAY_SECRET:gateway,GOOGLE_SERVICE_ACCOUNT_EMAIL:'synthetic@pilot.iam.gserviceaccount.com',
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}}).privateKey,
    OCR_PROVIDER:'http',OCR_HTTP_ENDPOINT:'https://synthetic-ocr.invalid/recognize',OCR_HTTP_TOKEN:'synthetic-only',
    OCR_ACKNOWLEDGE_DATA_TRANSFER:'true',OCR_MAX_DOCUMENTS_PER_RUN:'20',OCR_RUN_BUDGET_MS:'200000',
    AGENT_ENABLED:'false',TELEGRAM_ENABLED:'false'};
  console.log('Building actual Nexus against the isolated backend');
  command(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:app,env});
  log=createWriteStream(join(output,'browser-server.log'));
  server=spawn(process.execPath,['--import',join(root,'tests/pilot/external-boundaries.mjs'),join(root,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p','3100'],
    {cwd:app,env:{...env,NEXUS_SYNTHETIC_FIXTURES:fixturesPath,NEXUS_SYNTHETIC_REQUESTS:join(output,'external-requests.jsonl')},windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.pipe(log);server.stderr.pipe(log);
  for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:3100/login')).ok)break}catch{}if(i===119)throw new Error('Nexus did not start');await new Promise(r=>setTimeout(r,1000));}
  const req=createRequire(join(root,'package.json'));
  const {chromium}=req(process.env.NEXUS_TEST_PLAYWRIGHT||'playwright');
  const evidence=await runHistoricalForms({chromium,base:'http://127.0.0.1:3100',email,password,refs,sql,output,fixtures});
  const requests=readFileSync(join(output,'external-requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(requests.some(r=>r.kind==='drive'&&r.media),'Drive bytes must really pass through the application');
  assert.ok(requests.some(r=>r.kind==='ocr'),'OCR provider boundary must be exercised');
  assert.ok(requests.filter(r=>r.kind==='drive').every(r=>r.method==='GET'),'Drive is read-only');
  writeFileSync(join(output,'browser-result.json'),JSON.stringify({...evidence,backend:`Local Supabase, PostgreSQL ${version}`,externalRequests:requests.length},null,2));
  console.log('PASS full authenticated browser scenario',JSON.stringify(evidence));
}catch(error){
  console.error('BROWSER E2E FAILED:',error.message);
  if(log)await new Promise(r=>setTimeout(r,200));
  throw error;
}finally{
  if(server){server.kill('SIGTERM');await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));}
  log?.end();
  if(started){try{cli(['stop','--no-backup'])}catch{console.error('Could not stop isolated stack',project)}}
}
