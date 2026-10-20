import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';

export async function runHistoricalForms({chromium,base,email,password,refs,sql,output,fixtures}){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage();
  page.setDefaultTimeout(20000);
  const evidence={fullBrowserE2E:false,steps:[],checkpoints:[],twoTabWrites:false,manualConfirmationsPreserved:false};
  const q=text=>JSON.parse(sql(text));
  const step=name=>{evidence.steps.push(name);console.log('BROWSER STEP:',name)};
  const go=async path=>{await page.goto(base+path);await page.waitForLoadState('networkidle');assert.ok(!page.url().includes('/login'),`Session unexpectedly lost: ${path}`)};
  async function submit(form,label){
    const button=label?form.getByRole('button',{name:label,exact:true}):form.locator('button[type="submit"],button:not([type])').last();
    await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&r.url().startsWith(base)),button.click()]);
    await page.waitForLoadState('networkidle');
    const u=new URL(page.url());
    for(const key of ['error','source_error','drive_error'])if(u.searchParams.has(key))throw new Error(`${key}: ${u.searchParams.get(key)}`);
  }
  async function fill(form,values){for(const [name,value] of Object.entries(values)){
    const field=form.locator(`[name="${name}"]`);
    if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));
    else await field.fill(String(value));
  }}
  const formWith=(name,value)=>page.locator('form').filter({has:page.locator(`input[name="${name}"][value="${value}"]`)});
  let shipment;
  const items=()=>q(`select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sku',p.internal_sku,'transport',i.shipment_transport_id,'qty',i.ordered_quantity) order by i.id),'[]') from public.shipment_items i join public.products p on p.id=i.product_id where shipment_id='${shipment}';`);
  const snapshot=()=>q(`select jsonb_build_object(
    'stock',(select coalesce(jsonb_object_agg(uom,n),'{}') from(select bal.uom,sum(bal.quantity_on_hand) n from public.inventory_balances bal join public.inventory_batches b on b.id=bal.batch_id join public.products p on p.id=b.product_id where p.internal_sku like 'BROWSER-%' group by bal.uom)s),
    'reserved',(select coalesce(sum(bal.quantity_reserved),0) from public.inventory_balances bal join public.inventory_batches b on b.id=bal.batch_id join public.products p on p.id=b.product_id where p.internal_sku like 'BROWSER-%'),
    'movements',(select count(*) from public.inventory_movements m join public.inventory_batches b on b.id=m.batch_id join public.products p on p.id=b.product_id where p.internal_sku like 'BROWSER-%'),
    'receipts',(select count(*) from public.shipment_transport_receipts where shipment_id='${shipment}'));`);
  const checkpoint=(stage,expected)=>{const actual=snapshot();for(const [k,v]of Object.entries(expected))assert.deepEqual(actual[k],v,stage+': '+k);evidence.checkpoints.push({stage,...actual});step(stage)};
  try{
    await page.goto(base+'/login');
    await page.locator('[name="email"]').fill(email);await page.locator('[name="password"]').fill(password);
    await submit(page.locator('form'),'Войти');assert.ok(!page.url().includes('/login'));step('authenticated login');
    await go('/shipments');
    await page.locator('details.create-disclosure > summary').click();
    const create=page.locator('form.shipment-form');
    await fill(create,{project_code:'BROWSER-HISTORICAL',supplier_id:refs.supplier,route_id:refs.route,warehouse_id:refs.warehouse,currency_id:refs.eur});
    await submit(create,'Создать поставку');
    shipment=new URL(page.url()).pathname.split('/').at(-1);assert.match(shipment,/^[0-9a-f-]{36}$/);
    step('shipment created through form');
    await go(`/shipments/${shipment}?tab=items`);
    for(const [product,quantity,price] of [[refs.a,100,2],[refs.b,50,3]]){
      const f=page.locator('form').filter({has:page.locator('select[name="product_id"]')});
      await fill(f,{product_id:product,ordered_quantity:quantity,unit_price:price});await submit(f,'Добавить');
      await go(`/shipments/${shipment}?tab=items`);
    }
    await go(`/shipments/${shipment}?tab=delivery`);
    for(const letter of ['A','B']){
      await page.locator('details.transport-add > summary').click();
      const f=page.locator('details.transport-add form');
      await fill(f,{vehicle_plate:'PILOT-'+letter,trailer_plate:'TRAILER-'+letter,driver_name:'Synthetic Driver '+letter});
      await submit(f,'Добавить автомобиль');await go(`/shipments/${shipment}?tab=delivery`);
    }
    const vehicles=q(`select jsonb_agg(jsonb_build_object('id',id,'no',sequence_no) order by sequence_no) from public.shipment_transports where shipment_id='${shipment}';`);
    assert.equal(vehicles.length,2);
    for(const [sku,qty,vehicle]of [['BROWSER-A',60,vehicles[0]],['BROWSER-A',40,vehicles[1]],['BROWSER-B',50,vehicles[1]]]){
      await go(`/shipments/${shipment}?tab=items`);
      const item=items().find(i=>i.sku===sku&&!i.transport);assert.ok(item);
      const f=formWith('item_id',item.id).filter({has:page.locator('select[name="transport_id"]')});
      await fill(f,{transport_id:vehicle.id,quantity:qty});await submit(f,'Распределить');
    }
    assert.equal(items().reduce((n,i)=>n+Number(i.qty),0),150);step('two vehicles and cargo allocation');
    await go(`/shipments/${shipment}?tab=documents`);
    let f=page.locator('#drive-folder form').filter({has:page.locator('[name="folder"]')});
    await fill(f,{folder:`https://drive.google.com/drive/folders/${fixtures.folder}`});await submit(f,'Привязать папку');
    await go(`/shipments/${shipment}?tab=documents`);
    await submit(page.locator('#drive-folder form').filter({has:page.getByRole('button',{name:'Проверить папку',exact:true})}),'Проверить папку');
    const typeIds=q("select jsonb_object_agg(code,id) from public.document_types;");
    for(const file of fixtures.files){
      await go(`/shipments/${shipment}?tab=documents`);
      f=formWith('file_id',file.id).filter({has:page.locator('select[name="document_type_id"]')});
      const code=file.key.startsWith('cmr')?'cmr':file.key==='packing'?'packing_list':file.key==='customs'?'customs_declaration':'invoice';
      assert.ok(typeIds[code],code);await fill(f,{document_type_id:typeIds[code]});
      await f.locator('input[name="confirm"]').check();await submit(f);
    }
    assert.equal(q(`select count(*) from public.shipment_drive_files where shipment_id='${shipment}' and imported_document_id is not null;`),5);
    step('five files imported via read-only folder form');
    await go(`/shipments/${shipment}?tab=documents`);
    f=page.locator('#source-documents form').filter({has:page.getByRole('button',{name:'Распознать и сверить',exact:true})});
    await submit(f,'Распознать и сверить');
    const sources=()=>q(`select jsonb_agg(jsonb_build_object('id',e.id,'status',e.status,'file',f.file_id,'data',e.extracted_data,'confirmed',e.confirmed_data,'reviewed',e.reviewed_at) order by e.id) from public.shipment_source_extractions e join public.shipment_drive_files f on f.imported_document_id=e.document_id and f.shipment_id=e.shipment_id where e.shipment_id='${shipment}' and e.status<>'superseded';`);
    assert.equal(sources().length,5);
    assert.ok(sources().every(s=>['extracted','needs_review'].includes(s.status)),JSON.stringify(sources()));
    step('real OCR pipeline through synthetic HTTP boundary');
    // Review generic requisites through the actual source forms. No direct review RPC.
    for(const source of sources()){
      await go(`/shipments/${shipment}?tab=documents`);
      const details=page.locator('#source-documents details').filter({has:page.locator(`input[name="extraction_id"][value="${source.id}"]`)}).first();
      if(!await details.getAttribute('open'))await details.locator('summary').first().click();
      f=details.locator('form').filter({has:page.getByRole('button',{name:'Подтвердить данные',exact:true})});
      if(await f.count()){await submit(f,'Подтвердить данные');}
    }
    const confirmedBefore=sources().filter(s=>s.status==='confirmed');
    assert.ok(confirmedBefore.length>=4,'Invoice, two CMRs and packing must be manually confirmed');
    await go(`/shipments/${shipment}?tab=documents`);
    await submit(page.locator('#source-documents form').filter({has:page.getByRole('button',{name:'Распознать и сверить',exact:true})}),'Распознать и сверить');
    assert.deepEqual(sources().filter(s=>s.status==='confirmed'),confirmedBefore);evidence.manualConfirmationsPreserved=true;
    step('manual confirmations survive repeated recognition');
    // Continuing stages are added below; fail closed until every required form is exercised.
    throw new Error('Full form scenario is still being implemented after document review');
  }catch(error){
    writeFileSync(join(output,'browser-progress.json'),JSON.stringify(evidence,null,2));
    writeFileSync(join(output,'browser-failure.txt'),`URL: ${page.url()}\n${error.stack}\n\n${await page.locator('body').innerText().catch(()=>'(no page)')}`);
    await page.screenshot({path:join(output,'browser-failure.png'),fullPage:true}).catch(()=>{});
    throw error;
  }finally{await context.close();await browser.close();}
}
