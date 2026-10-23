// Actual React component + synthetic Server Actions. All external requests blocked. Does not start Nexus/Supabase.
// node scripts/test-receivables-ui.mjs <path-to-playwright> [screenshot-directory]
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
const output=await mkdtemp(join(tmpdir(),'nexus-import-ui-'));
let browser,server;
try {
 await new Promise((done,fail)=>bundle.webpack({mode:'development',devtool:false,entry:join(root,'tests/finance/import-preview.browser.tsx'),
  output:{path:output,filename:'app.js'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':join(root,'src'),
   [join(root,'src/app/finance/receivables/import-actions')]:join(root,'tests/finance/import-preview.mock.ts')}},
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
  await page.getByRole('button',{name:'Проверить с базой / обновить варианты'}).click();
  const confirm=page.getByRole('button',{name:'Подтвердить загрузку'});
  assert.equal(await confirm.isDisabled(),true);
  assert.equal(await page.locator('img').count(),0,'source HTML is rendered as text');
  await page.getByLabel('ID операции 1',{exact:true}).fill('SYNTH-STABLE-1');
  await page.getByLabel('Причина и основание решения').fill('Проверено по синтетическому реестру');
  assert.equal(await confirm.isDisabled(),true,'edits require renewed preview');
  await page.getByRole('button',{name:'Проверить с базой / обновить варианты'}).click();
  await page.getByText('Новая строка',{exact:true}).waitFor();assert.equal(await confirm.isDisabled(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>e.getBoundingClientRect().right>innerWidth).map(e=>[e.tagName,e.className,e.getBoundingClientRect().width]).slice(0,15))));
  if(process.argv[3]) {await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`import-${width}.png`),fullPage:true});}
  await confirm.click();await page.getByText('Синтетический пакет подтверждён один раз',{exact:true}).waitFor();
  assert.equal(await confirm.isDisabled(),true,'completed request cannot be clicked again');assert.deepEqual(errors,[]);
  console.log(`PASS import UI ${width}px: edits, re-preview, explicit confirm, HTML escaping, no page overflow`);await page.close();
 }
} finally {await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});}
