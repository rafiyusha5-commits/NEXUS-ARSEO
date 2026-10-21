import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {assertDockerEndpoint,assertProject,assertContainer,assertChecksum,assertLocalApi,storageMount,sha256} from './guards.mjs';

export function assertLocalDocker(command){
  const contexts=JSON.parse(command('docker',['context','inspect']));
  assertDockerEndpoint(process.env.DOCKER_HOST||contexts[0].Endpoints.docker.Host);
}
export async function runRecoveryDrill(c){
  const {root,work,project,command,sql,keys,refs,email,restrictedEmail,password,fixtures}=c;
  assertProject(project);assertLocalApi(keys.API_URL);assertLocalDocker(command);
  const started=performance.now(), timings={};
  const output=join(root,'test-results/recovery'),backup=join(work,'recovery-backup'),targetStack=join(work,'recovery-target');
  for(const path of [output,backup,targetStack])mkdirSync(path,{recursive:true,mode:0o700});
  const target='nexus-recovery-'+randomUUID().slice(0,8),runId=randomUUID();
  const docker=(args,options)=>command('docker',args,options);
  const containers=p=>{
    assertProject(p);const names=docker(['ps','-a','--filter',`name=_${p}$`,'--format','{{.Names}}']).trim().split('\n').filter(Boolean);
    for(const name of names)assertContainer(name,p);return names;
  };
  const inspect=name=>JSON.parse(docker(['inspect',name]))[0];
  // Supabase's postgres login is deliberately not its bootstrap superuser.
  // Only the existing local bootstrap role can restore Auth/Storage ownership.
  // Never grant privileges or strip ownership/ACL from the backup to bypass this.
  const restoreRole='supabase_admin';
  const assertBootstrapRole=db=>assert.equal(docker(['exec',db,'psql','-U',restoreRole,'-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1',
    '-c','select rolsuper from pg_roles where rolname=current_user;']).trim(),'t','Local Supabase bootstrap superuser is required');
  const sourceDb=`supabase_db_${project}`,sourceStorage=`supabase_storage_${project}`;
  const initialIds=new Map(containers(project).map(name=>[name,inspect(name).Id]));
  assert.ok(initialIds.has(sourceDb)&&initialIds.has(sourceStorage));
  assertBootstrapRole(sourceDb);
  const validateSource=()=>{for(const [name,id]of initialIds)assert.equal(inspect(name).Id,id,'Source container replaced');};
  const q=text=>JSON.parse(sql(text));
  async function login(k,account){
    const r=await fetch(new URL('/auth/v1/token?grant_type=password',assertLocalApi(k.API_URL)),{method:'POST',headers:{apikey:k.ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:account,password})});
    assert.equal(r.status,200,'Synthetic password login failed');return (await r.json()).access_token;
  }
  async function request(k,token,path,body,method='POST'){
    const r=await fetch(new URL(path,assertLocalApi(k.API_URL)),{method,headers:{apikey:k.ANON_KEY,Authorization:`Bearer ${token}`,'Content-Type':'application/json',Prefer:'return=representation'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.ok(r.ok,`Synthetic request failed: ${path.split('?')[0]} (${r.status})`);
    const text=await r.text();return text?JSON.parse(text):null;
  }
  const token=await login(keys,email);
  const rpc=(name,body)=>request(keys,token,'/rest/v1/rpc/'+name,body);
  const shipment=q("select to_jsonb(id) from public.shipments where project_code='BROWSER-HISTORICAL';");
  // Extend the existing completed pilot, not a parallel business fixture: retain an active reserve too.
  const order=await rpc('create_customer_order',{p_customer_id:refs.customer,p_contract_id:null,p_warehouse_id:refs.warehouse,
    p_planned_shipment_date:q('select to_jsonb(current_date);'),p_currency_id:refs.eur,p_notes:'Synthetic recovery active reservation'});
  const item=await rpc('add_customer_order_item',{p_sale_id:order,p_product_id:refs.b,p_quantity:1,p_uom:'piece',p_unit_price:3,p_required_shelf_life_pct:0});
  await rpc('reserve_customer_order_item_fefo',{p_sale_item_id:item});await rpc('confirm_customer_order',{p_sale_id:order});
  // Real Storage uploads, two different byte streams and the normal document version trigger.
  const document=randomUUID(),type=q("select to_jsonb(id) from public.document_types where code='invoice';");
  for(const [index,file]of fixtures.files.slice(0,2).entries()){
    const bytes=Buffer.from(file.base64,'base64'),path=`documents/${document}/${randomUUID().replaceAll('-','')}-synthetic-${index+1}.png`;
    const uploaded=await fetch(new URL('/storage/v1/object/nexus-documents/'+path,c.api),{method:'POST',headers:{apikey:keys.ANON_KEY,Authorization:`Bearer ${token}`,'Content-Type':'image/png'},body:bytes});
    assert.ok(uploaded.ok,'Synthetic Storage upload failed');
    if(index===0)await rpc('register_document',{p_document_id:document,p_document_type_id:type,p_title:'Synthetic recovery versioned document',p_storage_path:path,p_original_filename:'synthetic-1.png',p_checksum_sha256:sha256(bytes),p_links:[{entity_type:'shipment',entity_id:shipment}]});
    else await request(keys,token,'/rest/v1/document_versions',{document_id:document,storage_path:path,original_filename:'synthetic-2.png',checksum_sha256:sha256(bytes)});
  }
  const versions=q("select jsonb_agg(jsonb_build_object('document',document_id,'version',version_number,'current',is_current,'bucket',storage_bucket,'path',storage_path,'sha256',checksum_sha256) order by document_id,version_number) from public.document_versions;");
  assert.equal(versions.filter(v=>v.document===document).length,2);
  async function checkFiles(k,userToken,expected){
    const checked=[];
    for(const v of expected){
      const path='/storage/v1/object/authenticated/'+v.bucket+'/'+v.path.split('/').map(encodeURIComponent).join('/');
      const r=await fetch(new URL(path,assertLocalApi(k.API_URL)),{headers:{apikey:k.ANON_KEY,Authorization:`Bearer ${userToken}`}});
      assert.equal(r.status,200,'Version bytes unavailable after restore');const bytes=Buffer.from(await r.arrayBuffer());
      assertChecksum(bytes,v.sha256);checked.push({...v,bytes:bytes.length});
    }
    return checked;
  }
  const fileManifest=await checkFiles(keys,token,versions);
  const permissionSql=user=>`begin;set local role authenticated;select set_config('request.jwt.claim.sub','${user}',true);select jsonb_build_object('permissions',(select jsonb_object_agg(code,private.has_permission(code)) from public.permissions),'documents',(select count(*) from public.documents));rollback;`;
  const permissionSnapshot=(runner,user)=>JSON.parse(runner(permissionSql(user)).trim().split('\n').filter(x=>x.startsWith('{')).at(-1));
  const restricted=q(`select to_jsonb(id) from auth.users where email='${restrictedEmail}';`);
  const rights=[refs.user,restricted].map(u=>permissionSnapshot(sql,u));
  assert.equal(rights[1].permissions['documents.view'],false);assert.equal(rights[1].permissions['prices.purchase.view'],false);
  const counts=q("select jsonb_build_object('vehicles',(select count(*) from public.shipment_transports),'confirmed',(select count(*) from public.shipment_source_extractions where status='confirmed'),'history',(select count(*) from public.audit_log),'active_reservations',(select count(*) from public.inventory_reservations where status='active'),'fulfilled_reservations',(select count(*) from public.inventory_reservations where status='fulfilled'),'returns',(select count(*) from public.customer_returns),'costs',(select count(*) from public.cost_calculations where status='approved')); ");
  for(const key of Object.keys(counts))assert.ok(counts[key]>0,`Missing recovery coverage: ${key}`);
  sql(`create schema recovery_drill;create table recovery_drill.marker(id uuid primary key);insert into recovery_drill.marker values('${runId}');`);
  const noJobs=runner=>runner("do $$begin if to_regclass('cron.job') is not null then if exists(select 1 from cron.job where active) then raise exception 'Recovery refuses active cron';end if;end if; if to_regclass('net.http_request_queue') is not null then if exists(select 1 from net.http_request_queue) then raise exception 'Recovery refuses queued HTTP';end if;end if;end$$;");
  noJobs(sql);validateSource();
  // Quiesce all actual writers, including Auth/Storage; pg_dump and volume copy share a stable cut.
  docker(['stop',...containers(project).filter(n=>n!==sourceDb)]);
  const snapshotSql=readFileSync(join(root,'tests/recovery/snapshot.sql'),'utf8'),schemaSql=readFileSync(join(root,'tests/recovery/schema.sql'),'utf8');
  const snapshot=runner=>JSON.parse(runner(snapshotSql).trim());
  const before=snapshot(sql),schemaBefore=q(schemaSql);
  const sourceMount=storageMount(inspect(sourceStorage),project);
  const archive='storage.tar';
  function volumeTar(storage,args){
    assertContainer(storage,storage===sourceStorage?project:target);
    docker(['run','--rm','--pull=never','--network=none','--name','nexus-recovery-copy-'+randomUUID(),
      '--volumes-from',storage+(args[0]==='create'?':ro':''),'--mount',`type=bind,src=${backup},dst=/backup`,
      '--entrypoint','sh','postgres:16','-c',args[0]==='create'
        ?'tar -C /mnt -cf /backup/storage.tar .'
        :'test -z "$(find /mnt -type f -print -quit)" && tar -C /mnt -xf /backup/storage.tar']);
  }
  let mark=performance.now();
  docker(['exec',sourceDb,'pg_dump','-U',restoreRole,'-d','postgres','--format=custom','--file=/tmp/recovery.dump']);
  docker(['cp',`${sourceDb}:/tmp/recovery.dump`,join(backup,'database.dump')]);
  volumeTar(sourceStorage,['create']);timings.backupSeconds=(performance.now()-mark)/1000;
  const checksums={database:sha256(readFileSync(join(backup,'database.dump'))),storage:sha256(readFileSync(join(backup,archive)))};
  assert.deepEqual(snapshot(sql),before,'Source changed during backup');
  const sourceVersion=sql('show server_version;').trim();
  c.stopSource();assert.equal(containers(project).length,0,'Source infrastructure must be gone before restore');
  const targetCli=args=>command('supabase',['--workdir',targetStack,...args]);
  let targetStarted=false;
  try{
    assert.equal(containers(target).length,0);
    targetCli(['init','--yes']);const config=join(targetStack,'supabase/config.toml');
    writeFileSync(config,readFileSync(config,'utf8').replace(/^project_id = .*$/m,`project_id = "${target}"`).replace(/(\[db.seed\][\s\S]*?enabled = )true/,'$1false'));
    targetStarted=true;targetCli(['start','--exclude','studio,imgproxy,realtime,edge-runtime,logflare,vector,supavisor']);
    const targetKeys=JSON.parse(targetCli(['status','-o','json']));assertLocalApi(targetKeys.API_URL);
    const targetDb=`supabase_db_${target}`,targetStorage=`supabase_storage_${target}`;
    const targetId=inspect(targetDb).Id;
    assertBootstrapRole(targetDb);
    const restoredSql=text=>docker(['exec','-i',targetDb,'psql','-U','postgres','-d','postgres','-X','-qAt','-v','ON_ERROR_STOP=1'],{input:text});
    assert.equal(restoredSql('show server_version;').trim(),sourceVersion,'Restore requires matching engine version');
    assert.equal(restoredSql("select to_regclass('public.shipments') is null and not exists(select 1 from auth.users) and not exists(select 1 from storage.objects);").trim(),'t','Destination is not empty');
    restoredSql(`create schema recovery_drill;create table recovery_drill.marker(id uuid primary key);insert into recovery_drill.marker values('${runId}');`);
    assert.equal(restoredSql('select id from recovery_drill.marker;').trim(),runId);
    const targetMount=storageMount(inspect(targetStorage),target);
    assert.notEqual(targetMount.Source,sourceMount.Source,'Storage volumes must be independent');
    const services=containers(target).filter(n=>n!==targetDb);docker(['stop',...services]);
    assert.equal(inspect(targetDb).Id,targetId);assertChecksum(readFileSync(join(backup,'database.dump')),checksums.database);assertChecksum(readFileSync(join(backup,archive)),checksums.storage);
    mark=performance.now();
    // Exact newly created container + marker + empty app DB checked above. Never accept a destination argument.
    docker(['exec',targetDb,'dropdb','-U','postgres','--force','postgres']);
    docker(['exec',targetDb,'createdb','-U','postgres','--template=template0','postgres']);
    docker(['cp',join(backup,'database.dump'),`${targetDb}:/tmp/recovery.dump`]);
    // The destination was recreated from template0 above. --clean would issue
    // DROP POLICY ... ON storage.objects before the storage schema exists;
    // IF EXISTS on the policy does not guard its missing parent relation/schema.
    docker(['exec',targetDb,'pg_restore','-U',restoreRole,'-d','postgres','--exit-on-error','/tmp/recovery.dump']);
    timings.databaseRestoreSeconds=(performance.now()-mark)/1000;
    assert.deepEqual(snapshot(restoredSql),before,'Restored table contents differ');
    assert.deepEqual(JSON.parse(restoredSql(schemaSql)),schemaBefore,'Schema/RLS/ACL/sequences differ');
    noJobs(restoredSql);
    assert.deepEqual([refs.user,restricted].map(u=>permissionSnapshot(restoredSql,u)),rights,'Personal denies changed');
    mark=performance.now();volumeTar(targetStorage,['restore']);timings.fileRestoreSeconds=(performance.now()-mark)/1000;
    docker(['start',...services]);
    for(let i=0;i<120;i++){try{const r=await fetch(new URL('/auth/v1/health',c.api),{headers:{apikey:targetKeys.ANON_KEY}});if(r.ok)break;}catch{}if(i===119)throw new Error('Restored HTTP services unavailable');await new Promise(r=>setTimeout(r,500));}
    const restoredToken=await login(targetKeys,email),deniedToken=await login(targetKeys,restrictedEmail);
    assert.deepEqual(await checkFiles(targetKeys,restoredToken,versions),fileManifest);
    const denied=await fetch(new URL('/storage/v1/object/authenticated/'+versions[0].bucket+'/'+versions[0].path,c.api),{headers:{apikey:targetKeys.ANON_KEY,Authorization:`Bearer ${deniedToken}`}});
    assert.ok([400,401,403,404].includes(denied.status),'Denied employee downloaded restored file');
    const businessBefore=snapshot(restoredSql);
    mark=performance.now();await c.verifyApp(targetKeys,output);timings.appVerificationSeconds=(performance.now()-mark)/1000;
    const businessAfter=snapshot(restoredSql);
    for(const key of Object.keys(businessBefore).filter(k=>k.startsWith('public.')||k.startsWith('private.')))assert.deepEqual(businessAfter[key],businessBefore[key],`Read-only restart mutated ${key}`);
    const network=join(output,'network.jsonl');assert.ok(!existsSync(network)||readFileSync(network,'utf8').trim()==='','External operation attempted');
    noJobs(restoredSql);
    const report={passed:true,sourceDestroyedBeforeRestore:true,base:'009a0bedd3a371ceaeee66228e1dae4ca0b040d5',commit:command('git',['rev-parse','HEAD'],{cwd:root}).trim(),backend:`Real local Supabase / PostgreSQL ${sourceVersion}`,counts,checksums,files:fileManifest,
      tableFingerprints:before,schemaSha256:sha256(JSON.stringify(schemaBefore)),timings:{...timings,totalSeconds:(performance.now()-started)/1000},
      configuration:{appBuiltForDestination:true,authPasswordLogin:true,personalDeniesPreserved:true,externalOperations:0,schedules:0,externalProviderSecretsRestored:false},
      limitations:['Synthetic small dataset, not a production RTO/RPO estimate','Matching Supabase CLI/engine and bootstrap roles required; not cross-version migration','Synthetic local Auth users/passwords tested; external OAuth, SMTP, MFA and production key rotation not tested','Storage physical-volume backup is a local rehearsal adapter, not a managed-cloud Storage export command']};
    writeFileSync(join(output,'recovery-result.json'),JSON.stringify(report,null,2));
    console.log('PASS recovery drill',JSON.stringify({counts,checksums,timings:report.timings}));
  }finally{if(targetStarted)targetCli(['stop','--no-backup']);}
}
