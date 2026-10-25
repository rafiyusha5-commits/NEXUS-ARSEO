// Real interactive component, synthetic HTTP boundary. SQL behavior has separate PG tests.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),req=createRequire(join(root,'package.json'));
const {chromium}=req(process.argv[2]||'playwright');
const bundle=req('next/dist/compiled/webpack/webpack');
const output=await mkdtemp(join(tmpdir(),'nexus-assistant-ui-'));
let browser,server;
try{
 await new Promise((done,fail)=>bundle.webpack({mode:'development',devtool:false,
  plugins:[new bundle.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})],
  entry:join(root,'tests/agent/operations.browser.tsx'),output:{path:output,filename:'app.js'},
  resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':join(root,'src')}},
  module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:join(root,'scripts/test-tsx-loader.mjs')}]},
 },(error,stats)=>error||stats.hasErrors()?fail(error||Error(stats.toString({all:false,errors:true}))):done()));
 const js=await readFile(join(output,'app.js'));
 const css=(await readFile(join(root,'src/app/globals.css'),'utf8')).replace(/@import[^;]+;/g,'');
 server=createServer((request,response)=>{
  if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(js);}
  else response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{padding:16px;margin:0}main{max-width:1100px;margin:auto}</style><main id="root"></main><script src="/app.js"></script></html>`);
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
 for(const kind of ['transfer','order','draft','reserve','reserve-clean','confirmation','receiving','returns','decision-restock','decision-write_off','decision-return_to_supplier','cancel-return','expense-actual','expense-planned','expense-goods','confirm-expense-actual','confirm-expense-planned','confirm-expense-goods','allocate-quantity','allocate-weight','allocate-volume','allocate-value','allocate-paid','cost-same','cost-preliminary','cost-expense','approve-cost','approve-cost-empty','cancel-expense-draft','cancel-expense-planned','cancel-expense-goods','cancel-expense-allocated','reverse-expense-actual','reverse-expense-goods','payment-expense-actual','payment-expense-goods'])for(const width of [1440,390]){
  const expensePayment=kind.startsWith('payment-expense-');
  const expenseReverse=kind.startsWith('reverse-expense-');
  const expenseCancel=kind.startsWith('cancel-expense-');
  const approveCost=kind.startsWith("approve-cost");
  const cost=kind.startsWith("cost-");
  const allocation=kind.startsWith("allocate-");
  const expenseConfirm=kind.startsWith('confirm-expense-');
  const expense=kind.startsWith('expense-');
  const cancellation=kind==='cancel-return';
  const decision=kind.startsWith('decision-');
  const receiving=kind==='receiving',returns=kind==='returns';
  const confirmation=kind==='confirmation',reserve=kind.startsWith('reserve'),low=kind==='reserve',order=kind==='order',draft=kind==='draft',prepareLabel=expensePayment?"Предпросмотр фиксации оплаты":expenseReverse?"Предпросмотр сторнирования расхода":expenseCancel?"Предпросмотр отмены расхода":approveCost?"Предпросмотр утверждения":cost?"Предпросмотр себестоимости":allocation?"Рассчитать предпросмотр распределения":expenseConfirm?'Проверить расход перед подтверждением':expense?'Проверить параметры расхода':draft?'Проверить параметры заказа':'Проверить параметры и партии';
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],calls=[];let completed=false,rejectConfirmation=false,failPreparation=width===1440;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   if(!route.request().url().startsWith(url))return route.abort();
   if(!route.request().url().endsWith('/api/assistant/operations'))return route.continue();
   const body=route.request().postDataJSON();calls.push(body);
   if(body.action==='prepare'&&failPreparation){failPreparation=false;return route.abort();}
   if(body.action==='confirm'&&rejectConfirmation)return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'Заказ или права изменились. Обновите просмотр.'})});
   if(body.action==='confirm'){completed=true;return route.abort();} // committed, response lost
   const result=completed?{id:body.id,status:'completed',result_id:'10000000-0000-4000-8000-000000000099'}:
    {id:body.id,status:'awaiting_confirmation',review_token:'10000000-0000-4000-8000-000000000098',preview:{
     product:'SYNTH-150 · Синтетическое печенье 150 г',from:'AKT · Актобе',to:'AST · Астана',quantity:2,uom:'box',document_date:'2099-01-01',
     lines:[{balance_id:'a',batch:'SYNTH-FIRST',expiry:'2099-01-01',quantity:6,uom:'piece'},{balance_id:'b',batch:'SYNTH-SECOND',expiry:'2099-02-01',quantity:18,uom:'piece'}],
    }};
   result.kind=confirmation?'customer_order_confirm':reserve?'customer_order_reserve':draft?'customer_order_create':order?'customer_order_fulfillment':'inventory_transfer';
   if(draft&&!completed)result.preview={customer:'Синтетический покупатель',warehouse:'AKT · Актобе',contract:null,currency:'KZT',planned_date:'2099-01-20',document_date:'2099-01-01',total:'201.25',lines:[],items:[
    {id:'a',product:'Синтетическое печенье',quantity:'2',uom:'box',unit_price:'100.1250',line_amount:'200.2500',required_shelf_life_pct:70},
    {id:'b',product:'Синтетический сок',quantity:'3',uom:'piece',unit_price:'0.3333',line_amount:'0.9999',required_shelf_life_pct:null}]};
   if((order||reserve||confirmation)&&!completed)result.preview={order_number:'SYNTH-ORDER-77',customer:'Синтетический покупатель',warehouse:'AKT · Актобе',planned_date:'2099-01-01',document_date:'2099-01-01',
    items:[{id:'item-a',product:'Синтетическое печенье',quantity:2,uom:'box'}],lines:[
     {id:'r-a',product:'Синтетическое печенье',batch:'SYNTH-FIRST',expiry:'2099-02-01',quantity:6,uom:'piece',sale_quantity:0.5,sale_uom:'box'},
     {id:'r-b',product:'Синтетическое печенье',batch:'SYNTH-SECOND',expiry:'2099-03-01',quantity:18,uom:'piece',sale_quantity:1.5,sale_uom:'box'}]};
   if((reserve||confirmation)&&!completed){result.preview.low_shelf_life=low;for(const line of result.preview.lines){line.remaining_shelf_life_pct=low?25:80;line.required_shelf_life_pct=60;}}
   if(approveCost){result.kind='shipment_cost_approve';if(!completed)result.preview={calculation_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',version:3,currency:'KZT',goods_total:'1000.00',expenses_total:'100.00',landed_total:'1100.00',calculated_at:'2099-01-01',performer:'Директор',previous:kind==='approve-cost-empty'?[]:[{id:'old',version:1}],lines:[{item_id:'a',product:'Первый товар',sku:'SYN-1',quantity:'98',cost_quantity:'100',cost_quantity_basis:'shipped',uom:'piece',goods_amount:'1000.00',expenses:'100.00',total:'1100.00',unit_cost:'11.0000',rate:null,rate_date:null,rate_basis:'expense'}],batches:kind==='approve-cost-empty'?[]:[{id:'b',batch:'LOT-77',product:'Первый товар',old_cost:'10.0000',old_currency:'KZT',old_version:1,new_cost:'11.0000',new_currency:'KZT'}]};}
   if(cost){result.kind='shipment_cost_calculate';if(!completed)result.preview={shipment_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',currency:'KZT',version:3,approved_version:1,performer:'Бухгалтер',goods_total:1000,expenses_total:100,landed_total:1100,planned_total:null,planned_without_rate:1,excluded_count:1,item_units:{a:'piece'},products:{p:{name:'Первый товар',sku:'SYN-1'}},lines:[{shipment_item_id:'a',product_id:'p',quantity:98,cost_quantity:100,cost_quantity_basis:'shipped',goods_amount:1000,allocated_expenses:100,landed_amount:1100,unit_landed_cost:11,goods_rate:kind==='cost-expense'?null:1,goods_rate_date:kind==='cost-expense'?null:'2099-01-01',goods_rate_basis:kind==='cost-preliminary'?'calculation':kind==='cost-expense'?'expense':'same_currency'}]};}
   if(allocation){result.kind='expense_allocate';if(!completed)result.preview={expense_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',expense_type:'transport',payee:'Перевозчик',amount:'123.45',currency:'EUR',incurred_at:'2099-01-01',status:kind==='allocate-paid'?'paid':'confirmed',document:'Счёт 77',method:kind==='allocate-paid'?'by_quantity':'by_'+kind.slice(9),target_currency:'KZT',rate:'500',rate_date:'2099-01-01',rate_source:'bank',total:'61725.00',performer:'Бухгалтер',excluded_count:1,lines:[{item_id:'a',product:'Первый товар',sku:'SYN-1',quantity:'10',uom:'piece',quantity_source:'received',basis:'10',share:'0.333333333',amount:'20575.00'},{item_id:'b',product:'Второй товар',sku:'SYN-2',quantity:'20',uom:'piece',quantity_source:'shipped',basis:'20',share:'0.666666667',amount:'41150.00'}],previous:kind==='allocate-paid'?[{id:'old1',item_id:'a',product:'Первый товар',amount:'123.45',currency:'EUR',method:'by_quantity'}]:[]};}
   if(expenseReverse){result.kind='expense_reverse';if(!completed)result.preview={expense_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',customer:null,expense_type:kind.endsWith('goods')?'goods_cost':'transport',payee:'Перевозчик',amount:'1250.50',currency:'KZT',incurred_at:'2099-01-01',amount_kind:'actual',document:'Счёт 77',notes:null,creator:'Логист',performer:'Бухгалтер',status:'paid',paid_by:'Финансист',paid_at:'2099-01-02T10:00:00+00:00',allocation_count:2,reason:'Дублирующий оплаченный счёт'};}
   if(expenseCancel){result.kind='expense_cancel';if(!completed)result.preview={expense_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',customer:null,expense_type:kind.endsWith('goods')?'goods_cost':'transport',payee:'Перевозчик',amount:'1250.50',currency:'KZT',incurred_at:'2099-01-01',amount_kind:kind.endsWith('planned')?'planned':'actual',document:'Счёт 77',notes:null,creator:'Логист',performer:'Бухгалтер',status:kind.endsWith('allocated')?'allocated':kind.endsWith('draft')?'draft':'confirmed',allocation_count:kind.endsWith('allocated')?2:0,reason:'Дублирующий счёт'};}
   if(expenseConfirm){result.kind='expense_confirm';if(!completed)result.preview={expense_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',customer:null,expense_type:kind.endsWith('goods')?'goods_cost':'transport',payee:'Перевозчик',amount:'1250.50',currency:'KZT',incurred_at:'2099-01-01',amount_kind:kind.endsWith('planned')?'planned':'actual',document:'Счёт 77',notes:null,creator:'Логист',performer:'Бухгалтер'};}
   if(expensePayment){result.kind='expense_mark_paid';if(!completed)result.preview={expense_id:'10000000-0000-4000-8000-000000000077',shipment_number:'SHIP-77',customer:null,expense_type:kind.endsWith('goods')?'goods_cost':'transport',payee:'Перевозчик',amount:'1250.50',currency:'KZT',incurred_at:'2099-01-01',amount_kind:kind.endsWith('planned')?'planned':'actual',document:'Счёт 77',notes:null,creator:'Логист',performer:'Бухгалтер'};}
   if(expense){result.kind='expense_create';if(!completed)result.preview={shipment_number:'SHIP-77',expense_type:kind==='expense-goods'?'goods_cost':'transport',payee:null,amount:'1250.50',currency:'KZT',incurred_at:'2099-01-01',amount_kind:kind==='expense-planned'?'planned':'actual',document:null,notes:null,performer:'Сотрудник',existing_same_count:kind==='expense-goods'?1:0};}
   if(cancellation){result.kind='customer_return_cancel';if(!completed)result.preview={return_number:'RET-77',order_number:'SALE-77',customer:'Покупатель',warehouse:'AKT',reason:'Возврат оформлен ошибочно',total:'500.00',currency:'KZT',performer:'Сотрудник',document_date:'2099-01-01',lines:[{id:'l1',product:'Синтетический товар',batch:'LOT-1',quantity:'2.000',uom:'piece',amount:'500.00'}]};}
   if(decision){result.kind='customer_return_decide';if(!completed)result.preview={return_number:'RET-77',order_number:'SALE-77',customer:'Покупатель',product:'Синтетический товар',batch:'LOT-1',quantity:'2.000',uom:'piece',batch_status:'blocked',expiry:'2099-01-01',warehouse:'AKT',location:null,decision:kind.slice(9),note:kind==='decision-restock'?null:'Причина сотрудника',performer:'Сотрудник',document_date:'2099-01-01'};}
   if(returns){result.kind='customer_return_create';if(!completed)result.preview={order_number:'SYNTH-77',customer:'Покупатель',warehouse:'AKT',performer:'Сотрудник',document_date:'2099-01-01',reason:'Повреждение упаковки',total:'20.00',currency:'KZT',lines:[{sale_item_id:'i1',batch_id:'b1',product_name:'Синтетический товар',batch_number:'LOT-1',uom:'piece',quantity:'2',shipped:10,returned:1,available:9,reason_code:'damaged',unit_price:'10',amount:'20'}]};}
   if(receiving){result.kind='shipment_transport_receive';result.shipment_id='10000000-0000-4000-8000-000000000099';if(!completed)result.preview={shipment_number:'SYNTH-RECEIPT',vehicle:1,warehouse:'AKT · Актобе',location:null,performer:'Сотрудник',document_date:'2099-01-01',lines:[{id:'r1',product:'Синтетический товар',quantity:92,damaged:3,expected:100,basis:'shipped',shortage:5,overage:0,uom:'piece',batch:'LOT-1',manufacture_date:null,expiry:'2099-12-01',reason:'Недостача и повреждение'}]};}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto(url+`?${kind}`);await page.getByRole('heading',{name:expensePayment?"Фиксация оплаты расхода":expenseReverse?"Проверка сторнирования расхода":expenseCancel?"Проверка отмены расхода":approveCost?"Проверка утверждения себестоимости":cost?"Проверка расчёта себестоимости":allocation?"Проверка распределения расхода":expenseConfirm?'Бухгалтерское подтверждение расхода':expense?'Проверка нового расхода':cancellation?'Проверка отмены возврата':decision?'Решение по карантину возврата':returns?'Проверка возврата от покупателя':receiving?'Проверка фактической приёмки':confirmation?'Подготовка подтверждения заказа':reserve?'Подготовка резервирования':draft?'Подготовка нового заказа':order?'Подготовка отгрузки заказа':'Подготовка перемещения'}).waitFor();assert.equal(calls.length,0);
  await page.getByRole('button',{name:prepareLabel}).click();
  if(width===1440)await page.getByRole('button',{name:'Повторить подготовку с прежним ID'}).click();
  const confirm=page.getByRole('button',{name:expensePayment?"Зафиксировать оплату без перевода денег":expenseReverse?"Сторнировать расход без возврата денег":expenseCancel?"Отменить расход без возврата денег":approveCost?"Утвердить себестоимость без оплаты":cost?"Создать расчёт без утверждения":allocation?"Подтвердить распределение без оплаты":expenseConfirm?'Подтвердить расход без оплаты':expense?'Подтвердить и создать черновик расхода':cancellation?'Подтвердить отмену возврата':decision?'Подтвердить решение по возврату':returns?'Подтвердить и оформить возврат':receiving?'Подтвердить и принять товар':confirmation?'Подтвердить заказ без отгрузки':reserve?(low?'Продолжить резервирование с предупреждением':'Подтвердить резервирование'):draft?'Подтвердить и создать черновик заказа':order?'Подтвердить и отгрузить заказ полностью':'Подтвердить и выполнить перемещение'});await confirm.waitFor();
  if(reserve){assert.equal(await page.getByRole('note').count(),low?1:0);assert.match(await page.locator('body').innerText(),/Физический остаток, цены, платежи и долг не меняются/);}
  if(confirmation)assert.match(await page.locator('body').innerText(),/Резервы|резервы и платежи не меняются/);
  if(order)assert.match(await page.locator('body').innerText(),/Физический остаток уменьшится[\s\S]*Оплата не создаётся/);
  assert.equal(await confirm.isDisabled(),true);
  if(draft){assert.match(await page.locator('body').innerText(),/100.1250 KZT[\s\S]*0.3333 KZT[\s\S]*не задано[\s\S]*201.25 KZT/);assert.match(await page.locator('body').innerText(),/Остатки, платежи и задолженность не меняются/);}
  else if(expensePayment){const text=await page.locator("body").innerText();assert.match(text,/Распределён → Оплачен/);assert.match(text,/1250.50 KZT/);assert.match(text,/Кнопка не переводит деньги/);assert.match(text,/Частичная оплата здесь не поддерживается/);assert.match(text,/обычная отмена недоступна/);}
  else if(expenseReverse){const text=await page.locator('body').innerText();assert.match(text,/Оплачен → Сторнирован/);assert.match(text,/Финансист/);assert.match(text,/2099-01-02/);assert.match(text,/1250.50 KZT/);assert.match(text,/Сторнирование не означает, что деньги возвращены/);}
  else if(expenseCancel){const text=await page.locator('body').innerText();assert.match(text,/1250.50 KZT/);assert.match(text,/Дублирующий счёт/);assert.match(text,/Возврат денег, оплата, сторнирование и складские движения не выполняются/);if(kind.endsWith('allocated'))assert.match(text,/истории: 2/);if(kind.endsWith('goods'))assert.match(text,/не простое вычитание/);}
  else if(approveCost){const text=await page.locator('body').innerText();assert.match(text,/1100.00 KZT/);assert.match(text,/физические остатки не меняются/);if(kind==='approve-cost-empty')assert.match(text,/Связанных партий пока нет/);else assert.match(text,/Было: 10.0000 KZT[\s\S]*Станет: 11.0000 KZT[\s\S]*«Заменена»/);}
  else if(cost){const text=await page.locator('body').innerText();assert.match(text,/План для сравнения, не в итоге\s+Нет курса/);assert.match(text,/1100 KZT/);assert.match(text,/База стоимости: 100/);assert.match(text,/только черновик версии 3/);assert.match(text,/Утверждённая версия 1 сохраняется/);if(kind==='cost-preliminary')assert.match(text,/расчёт предварительный/);}
  else if(allocation){const text=await page.locator('body').innerText();assert.match(text,/20575.00 KZT[\s\S]*41150.00 KZT[\s\S]*61725.00 KZT/);assert.match(text,/остатки не меняются/);if(kind==='allocate-paid')assert.match(text,/заменено прежнее распределение[\s\S]*Новая оплата не создаётся/);}
  else if(expenseConfirm){const text=await page.locator('body').innerText();assert.match(text,/1250.50 KZT/);assert.match(text,/Оплата не создаётся/);assert.match(text,kind.endsWith('planned')?/План останется планом/:/Распределение по товарам/);}
  else if(expense){const text=await page.locator('body').innerText();assert.match(text,/1250.50 KZT/);assert.match(text,/Остатки и платежи не меняются/);assert.match(text,kind==='expense-planned'?/Плановый расход служит для сравнения/:/может блокировать новый расчёт/);if(kind==='expense-goods')assert.match(text,/совпадающих расходов: 1/);}
  else if(cancellation)assert.match(await page.locator('body').innerText(),/Уменьшение задолженности на 500.00 KZT[\s\S]*Складской остаток, резервы и платежи не меняются/);
  else if(decision){assert.match(await page.locator('body').innerText(),/Вся позиция возврата[\s\S]*Заблокирована/);assert.match(await page.locator('body').innerText(),kind==='decision-restock'?/Блокировка и карантин партии сохраняются/:kind==='decision-write_off'?/повторного списания со склада не будет/:/не создаёт перевозку/);}
  else if(returns)assert.match(await page.locator('body').innerText(),/карантин[\s\S]*уменьшит долг[\s\S]*Выплата денег не создаётся/);
  else if(receiving)assert.match(await page.locator('body').innerText(),/92 шт\.[\s\S]*повреждено: 3[\s\S]*Недостача: 5/);
  else assert.match(await page.locator('body').innerText(),/6 шт\.[\s\S]*18 шт\./);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.argv[3]){await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`assistant-${kind}-${width}.png`),fullPage:true});}
  await page.getByRole('checkbox').check();await confirm.click();await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(),/Ответ не получен/);assert.equal(calls.filter(c=>c.action==='confirm').length,1);
  await page.reload();await page.getByRole('button',{name:prepareLabel}).click();
  assert.equal(calls.filter(c=>c.action==='prepare').length,width===1440?2:1); // reload must not create another request
  await page.getByRole('button',{name:'Проверить состояние',exact:true}).click();
  const resultLink=page.getByRole('link',{name:approveCost||cost?'Открыть себестоимость':expensePayment||expenseReverse||expenseCancel||allocation||expense||expenseConfirm?'Открыть расходы':returns||decision||cancellation?'Открыть возвраты':receiving?'Открыть поставку':order||draft||reserve||confirmation?'Открыть заказ':'Открыть складской документ'});await resultLink.waitFor();
  assert.equal(await resultLink.getAttribute('href'),approveCost||cost||expensePayment||expenseReverse||expenseCancel||allocation||expense||expenseConfirm?'/finance':returns||decision||cancellation?'/sales/returns':`${receiving?'/shipments':order||draft||reserve||confirmation?'/sales':'/inventory/movements'}/10000000-0000-4000-8000-000000000099`);
  if(draft)assert.match(await page.locator('body').innerText(),/Черновик заказа создан. Резерв и отгрузка не выполнялись/);
  assert.equal(calls.filter(c=>c.action==='confirm').length,1);assert.equal(new Set(calls.map(c=>c.id)).size,1);
  await page.getByRole('button',{name:'Начать новый просмотр'}).click();completed=false;rejectConfirmation=true;
  await page.getByRole('button',{name:prepareLabel}).click();await confirm.waitFor();
  await page.getByRole('checkbox').check();await confirm.click();
  await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/Заказ или права изменились/);
  assert.equal(await confirm.count(),0);assert.equal(await resultLink.count(),0);
  assert.equal(calls.filter(c=>c.action==='confirm').length,2); // refused: no implicit repeat or success
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS assistant ${kind} ${width}px: explicit review, confirmation, lost response, reload, same request`);
 }
}finally{await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});}
