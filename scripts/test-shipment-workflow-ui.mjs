// Actual client components, synthetic actions. No live accounts or external services.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp,readFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),req=createRequire(join(root,'package.json'));
const {chromium}=req(process.argv[2]||'playwright'),bundle=req('next/dist/compiled/webpack/webpack');
const output=await mkdtemp(join(tmpdir(),'nexus-workflow-ui-'));
let browser,server;
try{
 await new Promise((done,fail)=>bundle.webpack({mode:'development',devtool:false,entry:join(root,'tests/agent/shipment-workflow.browser.tsx'),output:{path:output,filename:'app.js'},
  plugins:[new bundle.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})],
  resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':join(root,'src')}},module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:join(root,'scripts/test-tsx-loader.mjs')}]}
 },(error,stats)=>error||stats.hasErrors()?fail(error||Error(stats.toString({all:false,errors:true}))):done()));
 const js=await readFile(join(output,'app.js')),css=(await readFile(join(root,'src/app/globals.css'),'utf8')).replace(/@import[^;]+;/g,'');
 server=createServer((request,response)=>{if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(js);}else response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{padding:16px;margin:0}main{max-width:1100px;margin:auto}output{overflow-wrap:anywhere}</style><main id="root"></main><script src="/app.js"></script></html>`);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',r=>r.request().url().startsWith(url)?r.continue():r.abort());
  await page.goto(url);
  await page.getByRole('button',{name:'Привязать папку',exact:true}).waitFor();
  assert.equal(await page.locator('#calls').textContent(),'0');
  assert.equal(await page.getByLabel('Папка этой поставки в Google Drive').inputValue(),'https://drive.google.com/drive/folders/Synthetic_folder_123');
  assert.match(await page.getByRole('link',{name:'Открыть подготовку'}).getAttribute('href'),/^\/assistant\/shipments\?folder=/);
  await page.getByRole('button',{name:'Привязать папку',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#calls').textContent==='1');
  assert.match(await page.locator('#result').textContent(),/^\/assistant\/shipments\/.+\?step=files&success=/);
  await page.getByRole('button',{name:'Подтвердить данные',exact:true}).click();
  assert.equal(await page.locator('#calls').textContent(),'1','checkbox remains mandatory');
  await page.getByLabel('Проверил данные').check();
  await page.getByRole('button',{name:'Подтвердить данные',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('#calls').textContent==='2');
  assert.match(await page.locator('#result').textContent(),/\?step=review&source_success=/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
  if(process.argv[3]){await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`workflow-${width}.png`),fullPage:true});}
  console.log(`PASS ${width}px: no GET mutation, selected folder, return context, mandatory confirmation, no overflow`);
  await page.close();
 }
}finally{
 await browser?.close();if(server)await new Promise(done=>server.close(done));
 // mkdtemp gives a task-owned absolute child of tmpdir; never remove an input path.
 if(dirname(output)!==resolve(tmpdir())||!output.startsWith(join(resolve(tmpdir()),'nexus-workflow-ui-')))throw Error('UNSAFE_CLEANUP_TARGET');
 await rm(output,{recursive:true,force:true});
}
