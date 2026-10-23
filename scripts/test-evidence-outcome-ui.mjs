// Actual outcome component, synthetic evidence. External requests blocked; no Nexus/Supabase server.
// node scripts/test-evidence-outcome-ui.mjs <path-to-playwright> [screenshot-directory]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp,readFile,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), req=createRequire(join(root,'package.json'));
const {chromium}=req(process.argv[2]||'playwright');
const bundle=req('next/dist/compiled/webpack/webpack');
const output=await mkdtemp(join(tmpdir(),'nexus-outcome-ui-'));
let browser,server;
try {
 await new Promise((done,fail)=>bundle.webpack({mode:'development',devtool:false,entry:join(root,'tests/document-check/outcome.browser.tsx'),
  output:{path:output,filename:'app.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':join(root,'src')}},
  module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:join(root,'scripts/test-tsx-loader.mjs')}]},
 },(error,stats)=>error||stats.hasErrors()?fail(error||new Error(stats.toString({all:false,errors:true}))):done()));
 const js=await readFile(join(output,'app.js')),css=(await readFile(join(root,'src/app/globals.css'),'utf8')).replace(/@import[^;]+;/g,'');
 server=createServer((request,response)=>{if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(js);}else response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0;padding:16px;font-family:sans-serif}main{max-width:1100px;margin:auto}</style><main id="root"></main><script src="/app.js"></script></html>`);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
 for(const width of [1440,390]) {
  const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(url)?r.continue():r.abort());
  await page.goto(url);
  await page.getByText('1. Проверка чтения',{exact:true}).waitFor();
  const text=await page.locator('body').innerText();
  assert.match(text,/Чтение декларации подтверждено/);
  assert.match(text,/SYNTH-A: -35 шт\. к первоначальному заказу \(информация\)/);
  assert.match(text,/Основа сверки отгрузки — актуальные подтверждённые инвойс и упаковочный лист/);
  assert.match(text,/строк без замечаний: 1; расхождения: 0; нужна проверка или заполнение данных: 0/);
  assert.match(text,/Заказано: 1000 — отличие от потребности \(информация\)/);
  assert.match(text,/ДТ и упаковочный лист: состав и количества совпадают/);
  assert.match(text,/Не заполнено обязательных реквизитов/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'page overflows');
  assert.deepEqual(errors,[]);
  if(process.argv[3]) {await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`outcome-${width}.png`),fullPage:true});}
  console.log(`PASS outcome UI ${width}px: reading, -35 retained, packing, shared readiness, no page overflow`);await page.close();
 }
} finally {await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});}
