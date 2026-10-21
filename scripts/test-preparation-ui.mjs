// Real component, three synthetic sets. Persistence is tested in PostgreSQL and
// in the existing authenticated historical browser pilot, not mocked as proof here.
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
const output=await mkdtemp(join(tmpdir(),'nexus-preparation-ui-'));
let browser,server;
try{
  await new Promise((done,fail)=>bundle.webpack({mode:'development',devtool:false,
    plugins:[new bundle.webpack.DefinePlugin({'process.env':JSON.stringify({NODE_ENV:'development'})})],
    entry:join(root,'tests/documents/historical-preparation.browser.tsx'),output:{path:output,filename:'app.js'},
    resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':join(root,'src')}},
    module:{rules:[{test:/\.tsx?$/,exclude:/node_modules/,use:join(root,'scripts/test-tsx-loader.mjs')}]},
  },(error,stats)=>error||stats.hasErrors()?fail(error||Error(stats.toString({all:false,errors:true}))):done()));
  const js=await readFile(join(output,'app.js'));
  const css=(await readFile(join(root,'src/app/globals.css'),'utf8')).replace(/@import[^;]+;/g,'');
  server=createServer((request,response)=>{
    if(request.url==='/app.js'){response.setHeader('Content-Type','text/javascript');response.end(js);}
    else response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{padding:16px;margin:0}main{max-width:1100px;margin:auto}</style><main id="root"></main><script src="/app.js"></script></html>`);
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true});
  for(const width of [1440,390])for(const set of ['complete','incomplete','conflicting']){
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',r=>r.request().url().startsWith(url)?r.continue():r.abort());
    await page.goto(`${url}?set=${set}`);
    await page.getByRole('heading',{name:'Подготовка исторической поставки',exact:true}).waitFor();
    assert.equal(await page.locator('#result').textContent(),'');
    await page.getByLabel('Назначение проекта',{exact:true}).selectOption('true');
    assert.equal(await page.getByLabel('Назначение проекта',{exact:true}).inputValue(),'true');
    if(set!=='incomplete'){
      await page.locator('.historical-card select').first().selectOption('sale');
      await page.locator('.historical-card select').first().selectOption('procurement');
    }
    await page.getByRole('button',{name:'2. Источники значений',exact:true}).click();
    if(set==='complete')assert.match(await page.locator('body').innerText(),/965/);
    if(set==='conflicting'){
      assert.equal(await page.getByRole('heading',{name:'Противоречие количества',exact:true}).count(),2);
      assert.match(await page.locator('[role="status"]').first().innerText(),/965[\s\S]*960/);
      assert.equal(await page.locator('[role="status"] a[href*="version="]').count(),2);
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.argv[3]){await mkdir(resolve(process.argv[3]),{recursive:true});await page.screenshot({path:resolve(process.argv[3],`preparation-${set}-${width}.png`),fullPage:true});}
    await page.getByRole('button',{name:'3. Действия перед переносом',exact:true}).click();
    assert.match(await page.locator('body').innerText(),/отдельным основанием/);
    if(set==='incomplete')assert.match(await page.locator('body').innerText(),/Загрузить и проверить/);
    if(set==='conflicting')assert.match(await page.locator('body').innerText(),/есть расхождения/);
    await page.getByRole('button',{name:'Сохранить черновик',exact:true}).click();
    await page.getByText('Synthetic save requested',{exact:true}).waitFor();
    assert.deepEqual(errors,[]);await page.close();console.log(`PASS preparation ${set} ${width}px`);
  }
}finally{
  await browser?.close();if(server)await new Promise(done=>server.close(done));
  await rm(output,{recursive:true,force:true});
}
