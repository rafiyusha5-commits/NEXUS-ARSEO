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
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[],calls=[];let completed=false,failPreparation=width===1440;
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{
   if(!route.request().url().startsWith(url))return route.abort();
   if(!route.request().url().endsWith('/api/assistant/operations'))return route.continue();
   const body=route.request().postDataJSON();calls.push(body);
   if(body.action==='prepare'&&failPreparation){failPreparation=false;return route.abort();}
   if(body.action==='confirm'){completed=true;return route.abort();} // committed, response lost
   const result=completed?{id:body.id,status:'completed',result_id:'10000000-0000-4000-8000-000000000099'}:
    {id:body.id,status:'awaiting_confirmation',review_token:'10000000-0000-4000-8000-000000000098',preview:{
     product:'SYNTH-150 · Синтетическое печенье 150 г',from:'AKT · Актобе',to:'AST · Астана',quantity:2,uom:'box',document_date:'2099-01-01',
     lines:[{balance_id:'a',batch:'SYNTH-FIRST',expiry:'2099-01-01',quantity:6,uom:'piece'},{balance_id:'b',batch:'SYNTH-SECOND',expiry:'2099-02-01',quantity:18,uom:'piece'}],
    }};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
  });
  await page.goto(url);await page.getByRole('heading',{name:'Подготовка перемещения'}).waitFor();assert.equal(calls.length,0);
  await page.getByRole('button',{name:'Проверить параметры и партии'}).click();
  if(width===1440)await page.getByRole('button',{name:'Повторить подготовку с прежним ID'}).click();
  const confirm=page.getByRole('button',{name:'Подтвердить и выполнить перемещение'});await confirm.waitFor();
  assert.equal(await confirm.isDisabled(),true);assert.match(await page.locator('body').innerText(),/6 шт\.[\s\S]*18 шт\./);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(process.argv[3]){await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`assistant-operation-${width}.png`),fullPage:true});}
  await page.getByRole('checkbox').check();await confirm.click();await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(),/Ответ не получен/);assert.equal(calls.filter(c=>c.action==='confirm').length,1);
  await page.reload();await page.getByRole('button',{name:'Проверить параметры и партии'}).click();
  assert.equal(calls.filter(c=>c.action==='prepare').length,width===1440?2:1); // reload must not create another request
  await page.getByRole('button',{name:'Проверить состояние',exact:true}).click();
  await page.getByRole('link',{name:'Открыть складской документ'}).waitFor();
  assert.equal(calls.filter(c=>c.action==='confirm').length,1);assert.equal(new Set(calls.map(c=>c.id)).size,1);
  assert.deepEqual(errors,[]);await page.close();console.log(`PASS assistant ${width}px: explicit review, confirmation, lost response, reload, same request`);
 }
}finally{await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});}
