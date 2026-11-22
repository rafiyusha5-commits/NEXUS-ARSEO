import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
// After the first check the button of a Drive folder reads «Обновить из Drive» (202611220300).
const SCAN_FOLDER=/^(Проверить папку|Обновить из Drive)$/;

export async function runHistoricalForms({chromium,base,email,password,restrictedEmail,refs,sql,output,fixtures}){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
  const page=await context.newPage();
  page.on('pageerror',error=>console.error('BROWSER PAGE ERROR:',error.message));
  page.on('requestfailed',request=>console.error('BROWSER REQUEST FAILED:',request.method(),request.url(),request.failure()?.errorText));
  page.setDefaultTimeout(20000);
  page.setDefaultNavigationTimeout(30000);
  const scenarioTimeout=setTimeout(()=>{console.error('Browser scenario exceeded 12 minutes');void context.close();},720000);
  const evidence={fullBrowserE2E:false,steps:[],checkpoints:[],twoTabWrites:false,manualConfirmationsPreserved:false};
  const q=text=>JSON.parse(sql(text));
  const step=name=>{evidence.steps.push(name);console.log('BROWSER STEP:',name)};
  const go=async path=>{await page.goto(base+path);await page.waitForLoadState('networkidle');assert.ok(!page.url().includes('/login'),`Session unexpectedly lost: ${path}`)};
  async function submit(form,label){
    const button=label?form.getByRole('button',{name:label,exact:true}):form.locator('button[type="submit"],button:not([type])').last();
    const responsePromise=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().startsWith(base));
    await button.click();
    if(label==='Распознать и сверить'&&!evidence.ocrIndicator){
      await page.getByRole('button',{name:'Распознаём…',exact:true}).waitFor({state:'visible'});
      evidence.ocrIndicator=true;
    }
    const response=await responsePromise;
    console.log('FORM:',label??'submit',response.status(),response.headers()['x-action-redirect']??'(no redirect)');
    const redirect=response.headers()['x-action-redirect']?.split(';')[0]??response.headers().location;
    if(redirect)await page.waitForURL(new URL(redirect,base).href);
    await page.waitForLoadState('networkidle');
    const u=new URL(page.url());
    for(const key of ['error','source_error','drive_error'])if(u.searchParams.has(key)){
      const message=u.searchParams.get(key);
      // Existing UI uses source_error for a successful OCR batch that needs human review.
      // Only the explicit zero-unread summary is allowed; actual extraction rows are asserted next.
      if(key==='source_error'&&label==='Распознать и сверить'&&/^Готово к проверке: \d+; нужна проверка: \d+; не прочитано: 0(?:;|\.)/.test(message))continue;
      throw new Error(`${key}: ${message}`);
    }
  }
  async function fill(form,values){for(const [name,value] of Object.entries(values)){
    const field=form.locator(`[name="${name}"]`);
    if(await field.evaluate(el=>el.tagName)==='SELECT')await field.selectOption(String(value));
    else await field.fill(String(value));
  }}
  const formWith=(name,value)=>page.locator('form').filter({has:page.locator(`input[name="${name}"][value="${value}"]`)});
  const buttonForm=label=>page.locator('form').filter({has:page.getByRole('button',{name:label,exact:true})});
  const date=days=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
  let shipment;
  const items=()=>q(`select coalesce(jsonb_agg(jsonb_build_object('id',i.id,'sku',p.internal_sku,'transport',i.shipment_transport_id,'qty',i.ordered_quantity) order by i.id),'[]') from public.shipment_items i join public.products p on p.id=i.product_id where shipment_id='${shipment}';`);
  const snapshot=()=>q(`select jsonb_build_object(
    'stock',(select coalesce(jsonb_object_agg(uom,n),'{}') from(select bal.uom,sum(bal.quantity_on_hand) n from public.inventory_balances bal join public.inventory_batches b on b.id=bal.batch_id join public.products p on p.id=b.product_id where p.internal_sku in('990001','990002') group by bal.uom)s),
    'reserved',(select coalesce(sum(bal.quantity_reserved),0) from public.inventory_balances bal join public.inventory_batches b on b.id=bal.batch_id join public.products p on p.id=b.product_id where p.internal_sku in('990001','990002')),
    'movements',(select count(*) from public.inventory_movements m join public.inventory_batches b on b.id=m.batch_id join public.products p on p.id=b.product_id where p.internal_sku in('990001','990002')),
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
    for(const [sku,qty,vehicle]of [['990001',60,vehicles[0]],['990001',40,vehicles[1]],['990002',50,vehicles[1]]]){
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
    await submit(page.locator('#drive-folder form').filter({has:page.getByRole('button',{name:SCAN_FOLDER,exact:true})}),SCAN_FOLDER);
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
    const sources=()=>q(`select jsonb_agg(jsonb_build_object('id',e.id,'status',e.status,'file',f.file_id,'data',e.extracted_data,'confirmed',e.confirmed_data,'reviewed',e.reviewed_at,'transport',e.shipment_transport_id) order by e.id) from public.shipment_source_extractions e join public.shipment_drive_files f on f.imported_document_id=e.document_id and f.shipment_id=e.shipment_id where e.shipment_id='${shipment}' and e.status<>'superseded';`);
    assert.equal(sources().length,5);
    assert.ok(sources().every(s=>['extracted','needs_review'].includes(s.status)),JSON.stringify(sources()));
    assert.equal(sources().find(s=>s.file.endsWith('_invoice')).data.commodity_invoice.items.length,2);
    assert.equal(sources().find(s=>s.file.endsWith('_packing')).data.packing_evidence.total,150);
    assert.equal(sources().find(s=>s.file.endsWith('_customs')).data.customs_record.items.length,2);
    evidence.fourDocumentTypesParsed=true;
    step('real OCR pipeline through synthetic HTTP boundary');
    // Review generic requisites through the actual source forms. No direct review RPC.
    for(const source of sources()){
      await go(`/shipments/${shipment}?tab=documents`);
      const details=page.locator('#source-documents details').filter({has:page.locator(`input[name="extraction_id"][value="${source.id}"]`)}).first();
      if(await details.getAttribute('open')===null)await details.locator('summary').first().click();
      const file=fixtures.files.find(file=>file.id===source.file);
      if(file.key.startsWith('cmr')){
        const contextForm=details.locator('form').filter({has:page.locator('[name="context_reason"]')});
        await fill(contextForm,{transport_id:vehicles[file.key==='cmr1'?0:1].id,context_reason:'Synthetic original identifies this transport'});
        await submit(contextForm,'Сохранить контекст');
        await go(`/shipments/${shipment}?tab=documents`);
        if(await details.getAttribute('open')===null)await details.locator('summary').first().click();
      }
      f=details.locator('form').filter({has:page.getByRole('button',{name:'Подтвердить данные',exact:true})});
      if(file.key==='customs'){
        f=details.locator('form').filter({has:page.locator('[name="review_note"]')});
        await fill(f,{review_note:'Synthetic declaration original and commodity lines checked; no company data'});
        await f.locator('[name="checked"]').check();await submit(f,'Подтвердить сверку декларации');
      }else{
        if(file.key==='invoice')await fill(f,{field_order_number:'MANUAL-ORDER-VERIFIED'});
        await submit(f,'Подтвердить данные');
      }
    }
    const confirmedBefore=sources().filter(s=>s.status==='confirmed');
    assert.equal(confirmedBefore.length,5,'All five sources must be manually confirmed');
    assert.equal(confirmedBefore.find(s=>s.file.endsWith('_invoice')).confirmed.order_number,'MANUAL-ORDER-VERIFIED');
    await go(`/shipments/${shipment}?tab=documents`);
    await submit(page.locator('#source-documents form').filter({has:page.getByRole('button',{name:'Распознать и сверить',exact:true})}),'Распознать и сверить');
    assert.deepEqual(sources().filter(s=>s.status==='confirmed'),confirmedBefore);evidence.manualConfirmationsPreserved=true;
    await go(`/shipments/${shipment}?tab=documents`);
    await submit(page.locator('#drive-folder form').filter({has:page.getByRole('button',{name:SCAN_FOLDER,exact:true})}),SCAN_FOLDER);
    assert.equal(q('select count(*) from public.documents;'),5);
    assert.equal(q('select count(*) from public.document_versions;'),5);
    assert.deepEqual(sources().filter(s=>s.status==='confirmed'),confirmedBefore);
    assert.equal(items().reduce((n,i)=>n+Number(i.qty),0),150);
    step('manual confirmations survive repeated recognition');
    // Explicit employee action, not OCR auto-application: the invoice covers the whole shipment.
    // Its 100 pieces of Alpha are manually distributed 60/40 across the existing vehicle lines.
    const invoiceSource=sources().find(s=>s.file.endsWith('_invoice'));
    for(let attempt=0;attempt<2;attempt++){
      await go(`/shipments/${shipment}?tab=documents`);
      const details=page.locator('#source-documents details').filter({has:page.locator(`input[name="extraction_id"][value="${invoiceSource.id}"]`)}).first();
      if(await details.getAttribute('open')===null)await details.locator('summary').first().click();
      const quantities=details.locator('form.document-quantities');
      for(const item of items())await quantities.locator(`[name="qty_${item.id}"]`).fill(String(item.qty));
      await quantities.locator('[name="target"]').selectOption('both');
      await quantities.locator('[name="checked"]').check();
      await submit(quantities,'Записать количества');
      assert.equal(q(`select count(*) from public.shipment_item_quantity_confirmations where shipment_id='${shipment}';`),6,'repeat confirmation must not add history');
    }
    step('document quantities explicitly confirmed through existing form; retry kept six history rows');
    const documents=q(`select jsonb_object_agg(file_id,imported_document_id) from public.shipment_drive_files where shipment_id='${shipment}';`);
    for(const [index,vehicle]of vehicles.entries()){
      const document=documents[fixtures.files.find(x=>x.key===`cmr${index+1}`).id];
      await go(`/documents/${document}`);
      f=buttonForm('Добавить связь');
      const option=await f.locator('select[name="link"] option').filter({hasText:`Автомобиль №${index+1}`}).first().getAttribute('value');
      assert.equal(option,`shipment_transport:${vehicle.id}`);await fill(f,{link:option});await submit(f,'Добавить связь');
      if(index===0){
        await go(`/shipments/${shipment}/report`);
        assert.match(await page.locator('body').innerText(),/CMR[^\n]*автомобиль №2/i);
        evidence.missingSecondCmrDetected=true;
      }
    }
    await go(`/shipments/${shipment}/report`);
    assert.doesNotMatch(await page.locator('body').innerText(),/CMR[^\n]*автомобиль №[12]/i);
    evidence.bothCmrsPresent=true;step('missing second CMR detected and resolved by document link form');
    for(const [index,vehicle]of vehicles.entries()){
      await go(`/shipments/${shipment}?tab=delivery`);
      f=formWith('transport_id',vehicle.id).filter({has:page.locator('select[name="status"]')});
      await fill(f,{status:'in_transit'});await submit(f,'Сохранить');
      await go(`/shipments/${shipment}?tab=delivery`);
      f=formWith('transport_id',vehicle.id).filter({has:page.locator('select[name="status"]')});
      await fill(f,{status:'arrived'});await submit(f,'Сохранить');
      await go(`/shipments/${shipment}/receiving?transport=${vehicle.id}`);
      f=page.locator('form.receiving-form');
      for(const item of items().filter(i=>i.transport===vehicle.id)){
        const row=f.locator('fieldset').filter({has:page.locator(`input[name="item_id"][value="${item.id}"]`)});
        await fill(row,{accepted_quantity:index===0?57:item.qty,damaged_quantity:index===0?1:0,
          batch_number:`BROWSER-${index}-${item.sku}`,manufacture_date:date(index===0?-300:-30),expiry_date:date(index===0?100:370),
          discrepancy_reason:index===0?'Synthetic: 2 missing and 1 damaged':''});
      }
      await fill(f,{performed_by_name:'Synthetic Receiver',notes:'Disposable browser pilot'});
      await submit(f,'Завершить приёмку');
      // Refresh cannot repeat the receipt; the form is no longer available.
      await go(`/shipments/${shipment}/receiving?transport=${vehicle.id}`);
      assert.equal(await page.locator('form.receiving-form').count(),0);
      assert.match(await page.locator('body').innerText(),/уже принят/);
    }
    checkpoint('received',{stock:{piece:147},reserved:0,movements:3,receipts:2});
    const provenance=()=>q(`select jsonb_agg(jsonb_build_object('id',id,'vehicle',source_shipment_transport_id,'product',product_id) order by id) from public.inventory_batches where product_id in('${refs.a}','${refs.b}');`);
    const receivedBatches=provenance();assert.equal(receivedBatches.length,3);
    assert.ok(receivedBatches.every(b=>vehicles.some(v=>v.id===b.vehicle)));
    assert.equal(q(`select sum(received_quantity) from public.shipment_items where shipment_id='${shipment}';`),148);
    const beforeQuantityRead=snapshot();
    await go(`/shipments/${shipment}?tab=quantities`);
    const quantityPanel=page.getByRole('region',{name:'Откуда взялось количество',exact:true});
    assert.equal(await quantityPanel.locator('.quantity-lineage-item').count(),3);
    assert.match(await quantityPanel.innerText(),/годное 57 · повреждение 1 · недостача 2/);
    assert.match(await quantityPanel.innerText(),/включая повреждение/);
    assert.ok(await quantityPanel.locator('a[href^="/documents/"]').count()>=6,'available quantity sources missing');
    assert.match(await quantityPanel.innerText(),/версия 1/);
    assert.match(await quantityPanel.innerText(),/Количество подтвердил/);
    assert.equal(await quantityPanel.locator('form').count(),0);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      await quantityPanel.locator('summary').first().click();
      await page.screenshot({path:join(output,`quantity-provenance-${width}.png`),fullPage:true});
      assert.ok(await quantityPanel.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'provenance mobile overflow');
    }
    await page.reload();await page.waitForLoadState('networkidle');
    assert.deepEqual(snapshot(),beforeQuantityRead,'read/reload changed stock or receipts');
    await page.setViewportSize({width:1440,height:1000});
    evidence.quantityProvenance=true;step('quantity provenance: separate damage and shortage, responsive and read-only');
    await go('/sales');await page.locator('details.create-disclosure > summary').click();
    f=page.locator('form').filter({has:page.locator('select[name="customer_id"]')});
    await fill(f,{customer_id:refs.customer,warehouse_id:refs.warehouse,planned_shipment_date:date(1),currency_id:refs.eur});
    await submit(f,'Создать заказ');
    const sale=new URL(page.url()).pathname.split('/').at(-1);assert.match(sale,/^[0-9a-f-]{36}$/);
    await go(`/sales/${sale}?tab=items`);
    f=buttonForm('Добавить');
    await fill(f,{product_id:refs.a,quantity:7,uom:'box',unit_price:50,price_reason:'Синтетическая цена браузерной проверки',required_shelf_life_pct:60});await submit(f,'Добавить');
    await go(`/sales/${sale}?tab=shipping`);
    await submit(buttonForm('Резервировать по FEFO'),'Резервировать по FEFO');
    await go(`/sales/${sale}?tab=shipping`);
    await submit(buttonForm('Резервировать по FEFO'),'Резервировать по FEFO');
    assert.equal(snapshot().reserved,70);
    await go(`/sales/${sale}?tab=main`);
    // The first batch intentionally needs a shelf-life guarantee; since 202611180100 the form shows the actual reason.
    await assert.rejects(()=>submit(buttonForm('Подтвердить заказ'),'Подтвердить заказ'),/error: ОСГ ниже требования клиента/);
    assert.equal(q(`select to_jsonb(status) from public.sales where id='${sale}';`),'reserved');
    assert.ok(q(`select min(remaining_shelf_life_pct) from public.inventory_reservations r join public.sale_items i on i.id=r.sale_item_id where i.sale_id='${sale}' and r.status='active';`)<60);
    await go(`/sales/${sale}?tab=documents`);
    await submit(buttonForm('Проверить ОСГ и подготовить письмо'),'Проверить ОСГ и подготовить письмо');
    await go(`/sales/${sale}?tab=documents`);
    await submit(buttonForm('Утвердить'),'Утвердить');
    await go(`/sales/${sale}?tab=main`);await submit(buttonForm('Подтвердить заказ'),'Подтвердить заказ');
    checkpoint('reserved',{stock:{piece:147},reserved:70,movements:3,receipts:2});
    await go('/inventory/movements');await page.locator('details.create-disclosure > summary').click();
    f=buttonForm('Создать черновик');
    await fill(f,{operation_type:'transfer',from_warehouse_id:refs.warehouse,to_warehouse_id:refs.warehouse2,
      reference:'BROWSER-TRANSFER',reason:'Synthetic own warehouse transfer',performed_by_name:'Synthetic Receiver'});
    await submit(f,'Создать черновик');
    const movement=new URL(page.url()).pathname.split('/').at(-1);
    await go(`/inventory/movements/${movement}?tab=items`);
    f=buttonForm('Добавить строку');
    const balance=await f.locator('select[name="source_balance_id"] option').filter({hasText:'990002'}).getAttribute('value');
    assert.ok(balance);await fill(f,{source_balance_id:balance,quantity:10});await submit(f,'Добавить строку');
    await go(`/inventory/movements/${movement}`);await submit(buttonForm('Провести документ'),'Провести документ');
    checkpoint('transferred',{stock:{piece:147},reserved:70,movements:5,receipts:2});
    assert.deepEqual(provenance(),receivedBatches);
    await go(`/sales/${sale}?tab=shipping`);
    // Two real tabs submit the same server action with the same session.
    const second=await context.newPage();await second.goto(page.url());await second.waitForLoadState('networkidle');
    const post=async p=>{const [response]=await Promise.all([p.waitForResponse(r=>r.request().method()==='POST'&&r.url().startsWith(base)),
      p.getByRole('button',{name:'Отгрузить заказ полностью',exact:true}).click()]);
      assert.ok(response.status()<400);const redirect=response.headers()['x-action-redirect']?.split(';')[0]??response.headers().location;
      if(redirect)await p.waitForURL(new URL(redirect,base).href);await p.waitForLoadState('networkidle');
      assert.equal(new URL(p.url()).searchParams.has('error'),false);};
    await Promise.all([post(page),post(second)]);await second.close();
    assert.equal(q(`select to_jsonb(status) from public.sales where id='${sale}';`),'shipped');
    checkpoint('shipped',{stock:{piece:77},reserved:0,movements:7,receipts:2});evidence.twoTabWrites=true;
    await go(`/sales/${sale}?tab=returns`);
    f=page.locator('form.customer-return-form');
    const returnRow=f.locator('tbody tr').filter({hasText:'BROWSER-0-990001'});
    await returnRow.locator('input[name^="qty_"]').fill('1');
    await returnRow.locator('select').selectOption('refused');await fill(f,{reason:'Synthetic unopened box'});
    await submit(f,'Оформить возврат');
    await go(`/sales/${sale}?tab=returns`);
    f=page.locator('form.customer-return-decision');
    await fill(f,{decision:'restock',note:'Synthetic inspection: intact'});await submit(f,'Принять решение');
    checkpoint('returned',{stock:{piece:77,box:1},reserved:0,movements:8,receipts:2});
    assert.deepEqual(provenance(),receivedBatches);
    await go(`/finance?shipment=${shipment}`);f=buttonForm('Сохранить черновик');
    await fill(f,{shipment_id:shipment,expense_type:'transport',amount:50,currency_id:refs.eur,notes:'Synthetic actual freight'});
    await submit(f,'Сохранить черновик');
    await go(`/finance?shipment=${shipment}`);await submit(buttonForm('Подтвердить'),'Подтвердить');
    await go(`/finance?shipment=${shipment}`);f=buttonForm('Распределить');
    await fill(f,{method:'by_quantity',target_currency_id:refs.eur});await submit(f,'Распределить');
    await go(`/finance?shipment=${shipment}`);f=buttonForm('Рассчитать новую версию');
    await fill(f,{shipment_id:shipment,target_currency_id:refs.eur});await submit(f,'Рассчитать новую версию');
    await go(`/finance?shipment=${shipment}`);await submit(buttonForm('Утвердить себестоимость'),'Утвердить себестоимость');
    const costs=q(`select jsonb_build_object('goods',goods_total,'expenses',expenses_total,'total',landed_total,'status',status) from public.cost_calculations where shipment_id='${shipment}' order by version_number desc limit 1;`);
    assert.deepEqual(costs,{goods:346,expenses:50,total:396,status:'approved'});evidence.cost=costs;step('expense and costing approved through forms');
    const unfinished=()=>q(`select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'code',s.code) order by s.sequence_order,r.id),'[]') from public.shipment_stage_runs r join public.shipment_stages s on s.id=r.stage_id where r.shipment_id='${shipment}' and r.status not in('completed','skipped','not_applicable');`);
    for(const run of unfinished()){
      await go(`/shipments/${shipment}?tab=stages`);f=formWith('run_id',run.id);
      await fill(f,{status:'completed',reason:'Synthetic historical stage verified'});await submit(f,'Сохранить');
    }
    assert.equal(q(`select to_jsonb(status) from public.shipments where id='${shipment}';`),'closed');
    await go(`/shipments/${shipment}?tab=stages`);
    f=buttonForm('Открыть повторно');await fill(f,{reason:'Synthetic correction with auditable reason'});await submit(f,'Открыть повторно');
    assert.notEqual(q(`select to_jsonb(status) from public.shipments where id='${shipment}';`),'closed');
    for(const run of unfinished()){
      await go(`/shipments/${shipment}?tab=stages`);f=formWith('run_id',run.id);
      await fill(f,{status:'completed',reason:'Synthetic reclosure after verification'});await submit(f,'Сохранить');
    }
    checkpoint('closed',{stock:{piece:77,box:1},reserved:0,movements:8,receipts:2});
    assert.equal(q(`select to_jsonb(status) from public.shipments where id='${shipment}';`),'closed');
    await go(`/shipments/${shipment}/report`);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});await page.screenshot({path:join(output,`full-cycle-report-${width}.png`),fullPage:true});
      assert.match(await page.locator('body').innerText(),/Итог поставки/i);
      assert.match(await page.locator('body').innerText(),/396(?:[,.]00)?\s*EUR/);
    }
    await page.reload();await page.waitForLoadState('networkidle');assert.deepEqual(snapshot(),{
      stock:{piece:77,box:1},reserved:0,movements:8,receipts:2});
    const restrictedContext=await browser.newContext();
    const restrictedPage=await restrictedContext.newPage();
    await restrictedPage.goto(base+'/login');
    await restrictedPage.locator('[name="email"]').fill(restrictedEmail);await restrictedPage.locator('[name="password"]').fill(password);
    await restrictedPage.getByRole('button',{name:'Войти',exact:true}).click();
    await restrictedPage.waitForURL(base+'/');
    await restrictedPage.goto(`${base}/shipments/${shipment}/report`);await restrictedPage.waitForLoadState('networkidle');
    const restrictedText=await restrictedPage.locator('body').innerText();
    assert.match(restrictedText,/Нет доступа|нет прав/i);
    assert.doesNotMatch(restrictedText,/396(?:[,.]00)?\s*EUR/);
    await restrictedPage.goto(`${base}/shipments/${shipment}?tab=documents`);await restrictedPage.waitForLoadState('networkidle');
    assert.equal(await restrictedPage.getByRole('button',{name:'Подтвердить данные',exact:true}).count(),0);
    assert.equal(await restrictedPage.getByText('MANUAL-ORDER-VERIFIED',{exact:true}).count(),0);
    await restrictedPage.screenshot({path:join(output,'restricted-user.png'),fullPage:true});
    await restrictedPage.goto(`${base}/shipments/prepare?shipment=${shipment}`);await restrictedPage.waitForLoadState('networkidle');
    assert.match(await restrictedPage.locator('body').innerText(),/Проект или источники недоступны/);
    assert.equal(await restrictedPage.locator('.historical-card').count(),0);
    await restrictedPage.goto(`${base}/shipments/${shipment}?tab=quantities`);await restrictedPage.waitForLoadState('networkidle');
    const restrictedQuantities=restrictedPage.getByRole('region',{name:'Откуда взялось количество',exact:true});
    assert.match(await restrictedQuantities.innerText(),/Источник не зафиксирован/);
    assert.equal(await restrictedQuantities.locator('a[href^="/documents/"]').count(),0);
    assert.doesNotMatch(await restrictedQuantities.innerText(),/MANUAL-ORDER-VERIFIED/);
    await restrictedPage.screenshot({path:join(output,'quantity-provenance-restricted.png'),fullPage:true});
    await restrictedContext.close();evidence.permissionBoundary=true;step('independent restricted session hides documents and purchase cost');
    // A second, separate purchase proves the owner's paid-quantity rule through forms too.
    await go('/shipments');await page.locator('details.create-disclosure > summary').click();
    f=page.locator('form.shipment-form');await fill(f,{project_code:'BROWSER-PAID-100-98',supplier_id:refs.supplier,
      route_id:refs.route,warehouse_id:refs.warehouse,currency_id:refs.eur});await submit(f,'Создать поставку');
    const paidShipment=new URL(page.url()).pathname.split('/').at(-1);assert.match(paidShipment,/^[0-9a-f-]{36}$/);
    await go(`/shipments/${paidShipment}?tab=items`);f=buttonForm('Добавить');
    await fill(f,{product_id:refs.costProduct,ordered_quantity:100,unit_price:10});await submit(f,'Добавить');
    await go(`/shipments/${paidShipment}?tab=delivery`);await page.locator('details.transport-add > summary').click();
    f=page.locator('details.transport-add form');await fill(f,{vehicle_plate:'COST-100',driver_name:'Synthetic Cost Driver'});
    await submit(f,'Добавить автомобиль');
    const paidVehicle=q(`select to_jsonb(id) from public.shipment_transports where shipment_id='${paidShipment}';`);
    await go(`/shipments/${paidShipment}?tab=items`);
    f=page.locator('form.allocation-form');await fill(f,{transport_id:paidVehicle,quantity:100});await submit(f,'Распределить');
    for(const status of ['in_transit','arrived']){
      await go(`/shipments/${paidShipment}?tab=delivery`);
      f=formWith('transport_id',paidVehicle).filter({has:page.locator('select[name="status"]')});
      await fill(f,{status});await submit(f,'Сохранить');
    }
    await go(`/shipments/${paidShipment}/receiving?transport=${paidVehicle}`);f=page.locator('form.receiving-form');
    await fill(f,{accepted_quantity:98,damaged_quantity:0,batch_number:'BROWSER-PAID-98',
      manufacture_date:date(-30),expiry_date:date(370),discrepancy_reason:'Synthetic shortfall of two units',performed_by_name:'Synthetic Receiver'});
    await submit(f,'Завершить приёмку');
    await go(`/finance?shipment=${paidShipment}`);f=buttonForm('Сохранить черновик');
    await fill(f,{shipment_id:paidShipment,expense_type:'goods_cost',amount:1000,currency_id:refs.eur,notes:'Synthetic paid 100 at 10'});
    await submit(f,'Сохранить черновик');
    await go(`/finance?shipment=${paidShipment}`);await submit(buttonForm('Подтвердить'),'Подтвердить');
    await go(`/finance?shipment=${paidShipment}`);f=buttonForm('Распределить');
    await fill(f,{method:'by_quantity',target_currency_id:refs.eur});await submit(f,'Распределить');
    await go(`/finance?shipment=${paidShipment}`);await submit(buttonForm('Оплачен'),'Оплачен');
    await go(`/finance?shipment=${paidShipment}`);f=buttonForm('Рассчитать новую версию');
    await fill(f,{shipment_id:paidShipment,target_currency_id:refs.eur});await submit(f,'Рассчитать новую версию');
    const paidCost=q(`select jsonb_build_object('goods',i.goods_amount,'received',i.quantity,'basis',i.cost_quantity,'unitCost',i.unit_landed_cost)
      from public.cost_calculation_items i join public.cost_calculations c on c.id=i.calculation_id where c.shipment_id='${paidShipment}';`);
    assert.deepEqual(paidCost,{goods:1000,received:98,basis:100,unitCost:10});
    evidence.paidQuantityRule=paidCost;step('paid 100 received 98 keeps unit cost 10 through forms');
    await page.screenshot({path:join(output,'paid-quantity-cost.png'),fullPage:true});
    // Same authenticated stack, same synthetic folder and existing document matching.
    // Preparation writes only a draft, even for the already closed shipment.
    const preparationBefore=q(`select jsonb_build_object('items',(select jsonb_agg(to_jsonb(i) order by i.id) from public.shipment_items i where shipment_id='${shipment}'),
      'sources',(select jsonb_agg(to_jsonb(e) order by e.id) from public.shipment_source_extractions e where shipment_id='${shipment}'),
      'movements',(select count(*) from public.inventory_movements),'expenses',(select count(*) from public.expenses),'documents',(select count(*) from public.documents));`);
    await go(`/shipments/prepare?shipment=${shipment}`);
    await page.getByRole('heading',{name:'Подготовка исторической поставки',exact:true}).waitFor();
    assert.ok(await page.locator('.historical-card').count()>0);
    await page.getByLabel('Назначение проекта',{exact:true}).selectOption('true');
    await page.locator('.historical-card select').first().selectOption('procurement');
    await page.locator('.historical-card select').nth(1).selectOption('original');
    await submit(buttonForm('Сохранить черновик'),'Сохранить черновик');
    const draft=new URL(page.url()).searchParams.get('draft');assert.match(draft,/^[a-f0-9-]{36}$/);
    const saved=q(`select jsonb_build_object('revision',revision,'choices',choices,'prepare_new',prepare_new) from public.historical_shipment_drafts where id='${draft}';`);
    assert.equal(saved.prepare_new,true);assert.equal(saved.choices[0].group,'procurement');
    await page.reload();await page.waitForLoadState('networkidle');
    assert.equal(await page.locator('.historical-card select').first().inputValue(),'procurement');
    await submit(buttonForm('Сохранить черновик'),'Сохранить черновик');
    assert.equal(q(`select to_jsonb(revision) from public.historical_shipment_drafts where id='${draft}';`),saved.revision);
    await go(`/shipments/prepare?shipment=${shipment}&draft=${draft}`);
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      await page.getByRole('button',{name:'2. Источники значений',exact:true}).click();
      await page.getByRole('link',{name:'Источник строки',exact:true}).first().waitFor({state:'visible'});
      assert.ok(await page.getByRole('link',{name:'Источник строки',exact:true}).count()>0,'Existing parsed invoice/packing rows must be visible');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
      await page.screenshot({path:join(output,`preparation-${width}.png`),fullPage:true});
    }
    const reopened=await context.newPage();await reopened.goto(`${base}/shipments/prepare?shipment=${shipment}&draft=${draft}`);
    await reopened.getByRole('heading',{name:'Подготовка исторической поставки',exact:true}).waitFor();
    assert.equal(await reopened.locator('.historical-card select').first().inputValue(),'procurement');await reopened.close();
    assert.deepEqual(q(`select jsonb_build_object('items',(select jsonb_agg(to_jsonb(i) order by i.id) from public.shipment_items i where shipment_id='${shipment}'),
      'sources',(select jsonb_agg(to_jsonb(e) order by e.id) from public.shipment_source_extractions e where shipment_id='${shipment}'),
      'movements',(select count(*) from public.inventory_movements),'expenses',(select count(*) from public.expenses),'documents',(select count(*) from public.documents));`),preparationBefore);
    evidence.historicalPreparation=true;step('preparation draft persisted, reopened, replayed without business writes');
    evidence.fullBrowserE2E=true;step('closed report and refresh verified');return evidence;
  }catch(error){
    writeFileSync(join(output,'browser-progress.json'),JSON.stringify(evidence,null,2));
    writeFileSync(join(output,'browser-failure.txt'),`URL: ${page.url()}\n${error.stack}\n\n${await page.locator('body').innerText().catch(()=>'(no page)')}`);
    await page.screenshot({path:join(output,'browser-failure.png'),fullPage:true}).catch(()=>{});
    throw error;
  }finally{clearTimeout(scenarioTimeout);await context.close();await browser.close();}
}
