import assert from 'node:assert/strict';
import {join} from 'node:path';
export async function verifyRecoveredBrowser({chromium,email,restrictedEmail,password,output}){
  const browser=await chromium.launch({headless:true});
  try{
    for(const [label,account] of [['director',email],['restricted',restrictedEmail]]){
      const context=await browser.newContext({viewport:{width:1440,height:1000}});
      const blocked=[];
      await context.route('**/*',r=>new URL(r.request().url()).origin==='http://127.0.0.1:3100'?r.continue():(blocked.push('external request'),r.abort()));
      const page=await context.newPage();
      await page.goto('http://127.0.0.1:3100/login');
      await page.locator('[name="email"]').fill(account);await page.locator('[name="password"]').fill(password);
      await page.getByRole('button',{name:'Войти',exact:true}).click();await page.waitForURL('http://127.0.0.1:3100/');
      await page.goto('http://127.0.0.1:3100/shipments');await page.waitForLoadState('networkidle');
      const link=page.locator('a[href^="/shipments/"]').filter({hasText:/NAR-/}).first();
      assert.ok(await link.count(),'Restored shipment missing from UI');
      const href=await link.getAttribute('href');
      await page.goto('http://127.0.0.1:3100'+href.split('?')[0]+'/report');await page.waitForLoadState('networkidle');
      const text=await page.locator('body').innerText();
      if(label==='director')assert.match(text,/Отчёт|отчёт/);else assert.match(text,/Нет доступа|нет прав/i);
      for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.screenshot({path:join(output,`restored-${label}-${width}.png`),fullPage:true});}
      assert.deepEqual(blocked,[]);await context.close();
    }
  }finally{await browser.close();}
}
