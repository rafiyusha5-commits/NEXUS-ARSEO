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
 for(const kind of ['transfer','order','draft','reserve','reserve-clean'])for(const width of [1440,390]){
  const reserve=kind.startsWith('reserve'),low=kind==='reserve',order=kind==='order',draft=kind==='draft',prepareLabel=draft?'Проверить параметры заказа':'Проверить параметры и партии';
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
   result.kind=reserve?'customer_order_reserve':draft?'customer_order_create':order?'customer_order_fulfillment':'inventory_transfer';
   if(draft&&!completed)result.preview={customer:'Синтетический покупатель',warehouse:'AKT · Актобе',contract:null,currency:'KZT',planned_date:'2099-01-20',document_date:'2099-01-01',total:'201.25',lines:[],items:[
    {id:'a',product:'Синтетическое печенье',quantity:'2',uom:'box',unit_price:'100.1250',line_amount:'200.2500',required_shelf_life_pct:70},
    {id:'b',product:'Синтетический сок',quantity:'3',uom:'piece',unit_price:'0.3333',line_amount:'0.9999',required_shelf_life_pct:null}]};
   if((order||reserve)&&!completed)result.preview={order_number:'SYNTH-ORDER-77',customer:'Синтетический покупатель',warehouse:'AKT · Актобе',planned_date:'2099-01-01',document_date:'2099-01-01',
    items:[{id:'item-a',product:'Синтетическое печенье',quantity:2,uom:'box'}],lines:[
     {id:'r-a',product:'Синтетическое печенье',batch:'SYNTH-FIRST',expiry:'2099-02-01',quantity:6,uom:'piece',sale_quantity:0.5,sale_uom:'box'},
     {id:'r-b',product:'Синтетическое печенье',batch:'SYNTH-SECOND',expiry:'2099-03-01',quantity:18,uom:'piece',sale_quantity:1.5,sale_uom:'box'}]};
   if(reserve&&!completed){result.preview.low_shelf_life=low;for(const line of result.preview.lines){line.remaining_shelf_life_pct=low?25:80;line.required_shelf_life_pct=60;}}
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto(url+`?${kind}`);await page.getByRole('heading',{name:reserve?'Подготовка резервирования':draft?'Подготовка нового заказа':order?'Подготовка отгрузки заказа':'Подготовка перемещения'}).waitFor();assert.equal(calls.length,0);
  await page.getByRole('button',{name:prepareLabel}).click();
  if(width===1440)await page.getByRole('button',{name:'Повторить подготовку с прежним ID'}).click();
  const confirm=page.getByRole('button',{name:reserve?(low?'Продолжить резервирование с предупреждением':'Подтвердить резервирование'):draft?'Подтвердить и создать черновик заказа':order?'Подтвердить и отгрузить заказ полностью':'Подтвердить и выполнить перемещение'});await confirm.waitFor();
  if(reserve){assert.equal(await page.getByRole('note').count(),low?1:0);assert.match(await page.locator('body').innerText(),/Физический остаток, цены, платежи и долг не меняются/);}
  if(order)assert.match(await page.locator('body').innerText(),/Физический остаток уменьшится[\s\S]*Оплата не создаётся/);
  assert.equal(await confirm.isDisabled(),true);
  if(draft){assert.match(await page.locator('body').innerText(),/100.1250 KZT[\s\S]*0.3333 KZT[\s\S]*не задано[\s\S]*201.25 KZT/);assert.match(await page.locator('body').innerText(),/Остатки, платежи и задолженность не меняются/);}
  else assert.match(await page.locator('body').innerText(),/6 шт\.[\s\S]*18 шт\./);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.argv[3]){await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`assistant-${kind}-${width}.png`),fullPage:true});}
  await page.getByRole('checkbox').check();await confirm.click();await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(),/Ответ не получен/);assert.equal(calls.filter(c=>c.action==='confirm').length,1);
  await page.reload();await page.getByRole('button',{name:prepareLabel}).click();
  assert.equal(calls.filter(c=>c.action==='prepare').length,width===1440?2:1); // reload must not create another request
  await page.getByRole('button',{name:'Проверить состояние',exact:true}).click();
  const resultLink=page.getByRole('link',{name:order||draft||reserve?'Открыть заказ':'Открыть складской документ'});await resultLink.waitFor();
  assert.equal(await resultLink.getAttribute('href'),`${order||draft||reserve?'/sales':'/inventory/movements'}/10000000-0000-4000-8000-000000000099`);
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
