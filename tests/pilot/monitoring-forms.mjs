import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
export async function runMonitoringForms({chromium,base,email,password,restrictedEmail,refs,sql,output,api,keys,http,stopApp,startApp,root,work,hostEnv}) {
 assert.equal(base,'http://127.0.0.1:3100');assert.equal(api.origin,'http://127.0.0.1:54321');
 const headers={apikey:keys.SERVICE_ROLE_KEY,Authorization:`Bearer ${keys.SERVICE_ROLE_KEY}`,'Content-Type':'application/json'};
 assert.ok((await fetch(new URL('/storage/v1/bucket',api),{method:'POST',headers,body:JSON.stringify({id:'monitoring-canary',name:'monitoring-canary',public:false})})).ok);
 assert.ok((await fetch(new URL('/storage/v1/object/monitoring-canary/canary.txt',api),{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body:'nexus-canary'})).ok);
 sql(`insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select '${refs.user}',id,'allow','Synthetic monitoring browser check','${refs.user}' from public.permissions where code='system.health.view';`);
 const business=()=>sql(`select jsonb_build_object('shipments',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.shipments t),'sales',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.sales t),'stock',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.inventory_balances t),'expenses',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.expenses t));`);
 const before=business();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(30000);
 async function login(address){await page.goto(base+'/login');await page.locator('[name=email]').fill(address);await page.locator('[name=password]').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.waitForURL(url=>url.pathname!=='/login');}
 try{
  const live=await fetch(base+'/api/health/live');assert.equal(live.status,200);assert.deepEqual(await live.json(),{status:'ok'});
  const ready=await fetch(base+'/api/health/ready');assert.equal(ready.status,200);assert.deepEqual(await ready.json(),{status:'ok'});
  await login(email);await page.goto(base+'/admin/health');await page.getByRole('heading',{name:'Состояние системы',exact:true}).waitFor();
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.match(await page.locator('body').innerText(),/Не подтверждено: нет проверенного отчёта/);assert.ok(await page.getByRole('link',{name:'Обновить состояние'}).isVisible());await page.getByRole('link',{name:'Обновить состояние'}).focus();assert.equal(await page.getByRole('link',{name:'Обновить состояние'}).evaluate(el=>el===document.activeElement),true);await page.screenshot({path:join(output,`monitoring-${width}.png`),fullPage:true});}
  sql(`update public.profiles set user_type='external',counterparty_id='${refs.customer}' where id='${refs.user}';`);
  await page.reload();await page.waitForURL(url=>url.pathname.startsWith('/portal'));
  const signedIn=await fetch(new URL('/auth/v1/token?grant_type=password',api),{method:'POST',headers:{apikey:keys.ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.ok(signedIn.ok);
  const session=await signedIn.json();
  const portalRead=await fetch(new URL('/rest/v1/rpc/system_health_jobs',api),{method:'POST',headers:{apikey:keys.ANON_KEY,Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:'{}'});assert.equal(portalRead.status,403);
  sql(`update public.profiles set user_type='employee',counterparty_id=null where id='${refs.user}';`);
  await page.goto(base+'/admin/health');
  sql(`update public.user_permission_overrides set effect='deny' where user_id='${refs.user}' and permission_id=(select id from public.permissions where code='system.health.view');`);
  await page.reload();assert.match(await page.locator('body').innerText(),/Нет доступа к диагностике/);assert.equal(await page.getByRole('heading',{name:'Инциденты',exact:true}).count(),0);
  await context.clearCookies();await login(restrictedEmail);await page.goto(base+'/admin/health');assert.match(await page.locator('body').innerText(),/Нет доступа к диагностике/);
  // Anonymous REST calls cannot query diagnostics; browser login is not a substitute for RPC authorization.
  const anonymous=await fetch(new URL('/rest/v1/rpc/system_health_jobs',api),{method:'POST',headers:{apikey:keys.ANON_KEY,'Content-Type':'application/json'},body:'{}'});assert.ok([401,403].includes(anonymous.status));
  for(const mode of ['fail-before','hold']){
   await new Promise(r=>setTimeout(r,5100));const fault=http.arm('backend',mode);
   try{
    const start=Date.now(),request=fetch(base+'/api/health/ready');await fault.wait();
    assert.equal((await fetch(base+'/api/health/live')).status,200,'liveness must bypass unavailable Supabase');
    const response=await request;assert.equal(response.status,503);assert.ok(Date.now()-start<5000);assert.deepEqual(await response.json(),{status:'unavailable'});
   }finally{fault.release(true);}
  }
  // An actual independent process, with no database key or Supabase env, observes the real Next process stop.
  const logdir=join(work,'independent-observer');mkdirSync(logdir);const window=join(logdir,'window.json');
  writeFileSync(window,JSON.stringify({timeZone:'UTC',weekdays:[0,1,2,3,4,5,6],startHour:0,endHour:24,maintenanceUntil:null,reason:'Synthetic all-day test'}));
  const observe=()=>spawnSync(process.execPath,['--disable-warning=ExperimentalWarning',join(root,'scripts/monitor-system.mts'),'observe'],{env:{...hostEnv,MONITORING_ENABLED:'true',MONITORING_ENVIRONMENT:'test',MONITORING_APP_ORIGIN:base,MONITORING_LOG_DIRECTORY:logdir,MONITORING_WINDOW_FILE:window},encoding:'utf8',timeout:15000});
  assert.equal(observe().status,0);await stopApp();const down=observe();assert.equal(down.status,1);assert.match(down.stdout,/UNAVAILABLE/);await startApp();assert.equal(observe().status,0);
  assert.match(readFileSync(join(logdir,'observer-state.json'),'utf8'),/"code":"OK"/);
  assert.equal(business(),before,'Monitoring must not change stock, finance, sales or shipments');
  console.log('PASS monitoring: real Auth/Storage, permissions, faults <5s, app stop/recovery, 1440/390 keyboard, no business changes');
 }finally{await browser.close();sql(`update public.profiles set user_type='employee',counterparty_id=null where id='${refs.user}';delete from public.user_permission_overrides where user_id='${refs.user}' and permission_id=(select id from public.permissions where code='system.health.view');`);}
}
