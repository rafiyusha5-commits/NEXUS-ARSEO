import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {syntheticPng} from './external-fixtures.mjs';

export const FAULT_CASES=['download-before-storage','storage-before-registration','ocr-timeout-retry',
  'late-after-success','late-after-confirmation','source-version-change','access-revoked',
  'two-authorized-tabs','application-restart','mixed-batch'];

// Business operations use the actual authenticated UI. SQL only inspects evidence,
// injects a personal deny, or advances an already-created lease's clock in this disposable DB.
export async function runDocumentFaults({chromium,base,email,password,refs,sql,output,fixtures,http,restart,storageRead}){
  const q=s=>JSON.parse(sql(s)), browser=await chromium.launch({headless:true});
  const contexts=[], results=[];
  let page,other,shipment;
  const report=()=>writeFileSync(join(output,'document-faults.json'),JSON.stringify({fullHttpMatrix:results.length===FAULT_CASES.length,cases:results},null,2));
  const baseline=q(`select coalesce(jsonb_agg(to_jsonb(e) order by id),'[]') from public.shipment_source_extractions e where status='confirmed';`);
  assert.equal(baseline.length,5,'Existing manually reviewed historical fixtures must exist');
  const auditMax=q('select coalesce(max(id),0) from public.audit_log;');
  const originalAudit=q(`select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_log a where id<=${auditMax};`);
  const business=()=>q(`select jsonb_build_object('items',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.shipment_items t),
    'stock',(select coalesce(jsonb_agg(to_jsonb(t) order by batch_id,warehouse_id,uom),'[]') from public.inventory_balances t),
    'movements',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.inventory_movements t),
    'orders',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.sales t),
    'expenses',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.expenses t),
    'costs',(select coalesce(jsonb_agg(to_jsonb(t) order by id),'[]') from public.cost_calculations t));`);
  const businessBefore=business();
  const fixtureTemplate=structuredClone(fixtures.files.find(f=>f.key==='invoice'));
  async function go(p,path){await p.goto(base+path);await p.waitForLoadState('networkidle');assert.ok(!p.url().includes('/login'),'Authenticated session lost');}
  async function fill(form,values){for(const [name,value]of Object.entries(values)){const f=form.locator(`[name="${name}"]`);if(await f.evaluate(e=>e.tagName)==='SELECT')await f.selectOption(String(value));else await f.fill(String(value));}}
  function submit(p,form,label){
    const promise=(async()=>{
      const responsePromise=p.waitForResponse(r=>r.request().method()==='POST'&&r.url().startsWith(base),{timeout:110000});
      responsePromise.catch(()=>{}); // A killed server/page may reject the click before this waiter.
      await (label?form.getByRole('button',{name:label,exact:true}):form.locator('button[type="submit"],button:not([type])').last()).click({noWaitAfter:true});
      const response=await responsePromise;assert.ok(response.status()<500,`Action HTTP ${response.status()}`);
      const target=response.headers()['x-action-redirect']?.split(';')[0]??response.headers().location;
      if(target)await p.waitForURL(new URL(target,base).href,{timeout:110000});
      await p.waitForLoadState('networkidle');
      return new URL(p.url());
    })();
    promise.catch(()=>{});return promise;
  }
  const docs=p=>go(p,`/shipments/${shipment}?tab=documents`);
  const buttonForm=(p,label)=>p.locator('form').filter({has:p.getByRole('button',{name:label,exact:true})});
  async function login(){
    const c=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(c);
    await c.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
    const p=await c.newPage();p.setDefaultTimeout(25000);
    await p.goto(base+'/login');await fill(p.locator('form'),{email,password});await submit(p,p.locator('form'),'Войти');return p;
  }
  async function setup(name,count=1){
    fixtures.folder='Synthetic_fault_'+name.replaceAll('-','_');
    fixtures.files=Array.from({length:count},(_,i)=>{
      const key=`${name}-${i}`,bytes=syntheticPng(key);
      return {...fixtureTemplate,key,id:'Synthetic_'+key.replaceAll('-','_'),name:key+'.png',parents:[fixtures.folder],
        base64:bytes.toString('base64'),sha256:createHash('sha256').update(bytes).digest('hex'),size:String(bytes.length)};
    });
    await go(page,'/shipments');await page.locator('details.create-disclosure > summary').click();
    const f=page.locator('form.shipment-form');await fill(f,{project_code:'FAULT-'+name,supplier_id:refs.supplier,route_id:refs.route,warehouse_id:refs.warehouse,currency_id:refs.eur});
    await submit(page,f,'Создать поставку');
    shipment=q(`select to_jsonb(id) from public.shipments where project_code='FAULT-${name}';`);assert.match(shipment,/^[a-f0-9-]{36}$/);
    await docs(page);const bind=page.locator('#drive-folder form').filter({has:page.locator('[name="folder"]')});
    await fill(bind,{folder:`https://drive.google.com/drive/folders/${fixtures.folder}`});await submit(page,bind,'Привязать папку');
    await docs(page);await submit(page,buttonForm(page,'Проверить папку'),'Проверить папку');
  }
  async function importForm(p,file){
    await docs(p);const f=p.locator('form').filter({has:p.locator(`input[name="file_id"][value="${file.id}"]`)}).filter({has:p.locator('select[name="document_type_id"]')});
    await fill(f,{document_type_id:q("select to_jsonb(id) from public.document_types where code='invoice';")});await f.locator('[name="confirm"]').check();return f;
  }
  const count=()=>q(`select count(*) from public.shipment_drive_files where shipment_id='${shipment}' and imported_document_id is not null;`);
  const sources=()=>q(`select coalesce(jsonb_agg(to_jsonb(e) order by document_id),'[]') from public.shipment_source_extractions e where shipment_id='${shipment}';`);
  const objects=()=>q("select coalesce(jsonb_agg(name order by name),'[]') from storage.objects where bucket_id='nexus-documents';");
  async function verifyFiles(expected){
    const versions=q(`select coalesce(jsonb_agg(to_jsonb(v) order by v.id),'[]') from public.document_versions v join public.shipment_drive_files f on f.imported_document_id=v.document_id where f.shipment_id='${shipment}';`);
    assert.equal(count(),expected);assert.equal(versions.length,expected,'One version per imported file');
    for(const v of versions){const bytes=await storageRead(v.storage_bucket,v.storage_path);assert.equal(createHash('sha256').update(bytes).digest('hex'),v.checksum_sha256);}
    assert.equal(q(`select count(*) from public.document_links where entity_type='shipment' and entity_id='${shipment}' and removed_at is null;`),expected);
    return versions;
  }
  async function importAll(){for(const file of fixtures.files){const result=await submit(page,await importForm(page,file));assert.ok(!result.searchParams.has('error'),result.href);}await verifyFiles(fixtures.files.length);}
  async function ocr(p){await docs(p);return submit(p,buttonForm(p,'Распознать и сверить'),'Распознать и сверить');}
  const expire=()=>sql(`update public.shipment_source_extractions set processing_started_at=clock_timestamp()-interval '2 hours',ocr_lease_until=clock_timestamp()-interval '1 minute' where shipment_id='${shipment}' and status='pending';`);
  async function confirmed(p){
    await docs(p);const s=sources()[0];
    const details=p.locator('#source-documents details').filter({has:p.locator(`input[name="extraction_id"][value="${s.id}"]`)}).first();
    if(await details.getAttribute('open')===null)await details.locator('summary').first().click();
    const f=details.locator('form').filter({has:p.getByRole('button',{name:'Подтвердить данные',exact:true})});
    await f.locator('[name="field_order_number"]').fill('MANUAL-FAULT-REVIEW');await submit(p,f,'Подтвердить данные');
    assert.equal(sources()[0].status,'confirmed');
  }
  function passed(name,detail){
    assert.deepEqual(business(),businessBefore,'Document faults must not change business quantities, stock or sales');
    const ids=baseline.map(e=>`'${e.id}'`).join(',');
    assert.deepEqual(q(`select jsonb_agg(to_jsonb(e) order by id) from public.shipment_source_extractions e where id in(${ids});`),baseline,'Existing manual confirmations must remain byte-for-byte identical');
    assert.deepEqual(q(`select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_log a where id<=${auditMax};`),originalAudit,'Previously saved history was changed');
    results.push({name,status:'passed',...detail});report();console.log('FAULT PASS:',name,JSON.stringify(detail));
  }
  try {
    page=await login();other=await login();
    await setup(FAULT_CASES[0]);
    let before=objects(), gate=http.arm('storage-upload','fail-before');
    let url=await submit(page,await importForm(page,fixtures.files[0]));await gate.wait();
    assert.ok(url.searchParams.has('error'));assert.equal(count(),0);assert.deepEqual(objects(),before);
    await importAll();passed(FAULT_CASES[0],{registered:1,storageVerified:true});

    await setup(FAULT_CASES[1]);before=objects();gate=http.arm('import-rpc','fail-before');
    url=await submit(page,await importForm(page,fixtures.files[0]));await gate.wait();assert.ok(url.searchParams.has('error'));assert.equal(count(),0);
    const staging=objects().filter(n=>!before.includes(n));assert.equal(staging.length,1);
    assert.equal(createHash('sha256').update(await storageRead('nexus-documents',staging[0])).digest('hex'),fixtures.files[0].sha256);
    await importAll();assert.ok(objects().includes(staging[0]),'Uncertain staging must not be deleted');
    // Also lose a response AFTER commit: a retry must find the saved receipt.
    fixtures.files.push({...fixtures.files[0],id:fixtures.files[0].id+'_receipt'});
    await docs(page);await submit(page,buttonForm(page,'Проверить папку'),'Проверить папку');
    const receiptForm=await importForm(other,fixtures.files[1]);
    gate=http.arm('import-rpc','fail-after');url=await submit(page,await importForm(page,fixtures.files[1]));await gate.wait();assert.ok(url.searchParams.has('error'));
    assert.equal(count(),2); // two file links to the SAME document; no second business document
    const committedObjects=objects();await submit(other,receiptForm);assert.deepEqual(objects(),committedObjects,'Receipt retry uploaded duplicate bytes');
    assert.equal(q(`select count(distinct imported_document_id) from public.shipment_drive_files where shipment_id='${shipment}';`),1);
    passed(FAULT_CASES[1],{registeredDocuments:1,retainedUncertainStaging:1,lostCommittedResponse:true});

    await setup(FAULT_CASES[2]);await importAll();gate=http.arm('ocr');let pending=ocr(page);await gate.wait();
    await pending;assert.equal(sources()[0].status,'failed');assert.match(sources()[0].error_message,/вовремя/);gate.release(true);
    await ocr(page);assert.ok(['extracted','needs_review'].includes(sources()[0].status));await verifyFiles(1);
    passed(FAULT_CASES[2],{attempts:sources()[0].attempt_count,actualClientTimeout:true});

    for(const name of [FAULT_CASES[3],FAULT_CASES[4]]){
      await setup(name);await importAll();gate=http.arm('ocr');pending=ocr(page);await gate.wait();
      expire();await ocr(other);assert.ok(['extracted','needs_review'].includes(sources()[0].status));
      if(name===FAULT_CASES[4])await confirmed(other);
      const saved=sources();gate.release();await pending;assert.deepEqual(sources(),saved,'Late HTTP response overwrote newer data');await verifyFiles(1);
      passed(name,{wholeExtractionUnchanged:true,manualConfirmed:name===FAULT_CASES[4]});
    }

    await setup(FAULT_CASES[5]);before=objects();gate=http.arm('drive-media');pending=submit(page,await importForm(page,fixtures.files[0]));await gate.wait();
    fixtures.files[0].version='2';fixtures.files[0].modifiedTime='2026-02-01T00:00:00Z';gate.release();url=await pending;
    assert.ok(url.searchParams.has('error'));assert.equal(count(),0);assert.deepEqual(objects(),before);
    await docs(page);await submit(page,buttonForm(page,'Проверить папку'),'Проверить папку');await importAll();passed(FAULT_CASES[5],{staleRegistrationRejected:true,explicitRescanSucceeded:true});

    await setup(FAULT_CASES[6]);before=objects();gate=http.arm('drive-media');pending=submit(page,await importForm(page,fixtures.files[0]));await gate.wait();
    fixtures.files[0].parents=[];gate.release();url=await pending;
    assert.ok(url.searchParams.has('error'));assert.equal(count(),0);assert.deepEqual(objects(),before,'Revoked Drive source was uploaded');
    fixtures.files[0].parents=[fixtures.folder];await importAll();gate=http.arm('ocr');pending=ocr(page);await gate.wait();
    sql(`insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select '${refs.user}',id,'deny','FAULT temporary deny','${refs.user}' from public.permissions where code='source_documents.extract';`);
    const denied=sources();gate.release();await pending;assert.deepEqual(sources(),denied,'Revoked employee persisted OCR result');
    sql(`delete from public.user_permission_overrides where user_id='${refs.user}' and reason='FAULT temporary deny';`);
    expire();await ocr(page);assert.ok(['extracted','needs_review'].includes(sources()[0].status));await verifyFiles(1);
    passed(FAULT_CASES[6],{driveScopeRevokedDuringHttp:true,personalDenyDuringHttp:true,resultRejected:true});

    await setup(FAULT_CASES[7]);const first=await importForm(page,fixtures.files[0]),second=await importForm(other,fixtures.files[0]);
    gate=http.arm('import-rpc');pending=submit(page,first);await gate.wait();url=await submit(other,second);
    assert.equal(count(),0);assert.ok(url.searchParams.has('error'),'Second import should report busy');gate.release();await pending;await verifyFiles(1);
    const calls=http.events.filter(e=>e.kind==='ocr').length;
    gate=http.arm('ocr');pending=ocr(page);await gate.wait();await ocr(other);assert.equal(http.events.filter(e=>e.kind==='ocr').length,calls+1);gate.release();await pending;await verifyFiles(1);
    passed(FAULT_CASES[7],{authorizedContexts:2,providerCalls:1,registered:1});

    await setup(FAULT_CASES[8]);await importAll();before=objects();gate=http.arm('ocr');pending=ocr(page);await gate.wait();
    const interrupted=sources();assert.equal(interrupted[0].status,'pending');
    await restart();gate.release(true);await page.close();await pending.catch(()=>{});page=await login();
    assert.deepEqual(objects(),before);assert.deepEqual(sources(),interrupted,'App restart altered saved lease');
    await ocr(other);assert.equal(sources()[0].status,'pending','Unexpired lease must stay busy');
    expire();await docs(other);assert.match(await other.locator('#source-documents').innerText(),/Требуется действие|Ожидает повторения|прерван/i);
    await ocr(other);assert.ok(['extracted','needs_review'].includes(sources()[0].status));await verifyFiles(1);
    passed(FAULT_CASES[8],{actualProcessKilled:true,storagePreserved:true,leaseClockAdvancedOnly:true});

    await setup(FAULT_CASES[9],3);await importAll();gate=http.arm('ocr','fail-before',fixtures.files[1].id);
    await ocr(page);await gate.wait();const mixed=sources();assert.equal(mixed.filter(s=>s.status==='failed').length,1);assert.equal(mixed.filter(s=>['extracted','needs_review'].includes(s.status)).length,2);
    const successful=mixed.filter(s=>s.status!=='failed');await ocr(page);assert.equal(sources().filter(s=>['extracted','needs_review'].includes(s.status)).length,3);
    for(const saved of successful)assert.deepEqual(sources().find(s=>s.id===saved.id),saved,'Retry changed an already successful file');
    await verifyFiles(3);await page.screenshot({path:join(output,'document-faults-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'document-faults-mobile.png'),fullPage:true});
    passed(FAULT_CASES[9],{firstPass:{success:2,failed:1},afterRetry:3,successfulRowsUnchanged:true});
    assert.deepEqual(results.map(r=>r.name),FAULT_CASES);return results;
  }catch(error){report();if(page){writeFileSync(join(output,'document-fault-failure.txt'),`${error.stack}\n${page.url()}\n${await page.locator('body').innerText().catch(()=>'(closed)')}`);await page.screenshot({path:join(output,'document-fault-failure.png'),fullPage:true}).catch(()=>{});}throw error;}
  finally{for(const c of contexts)await c.close();await browser.close();}
}
