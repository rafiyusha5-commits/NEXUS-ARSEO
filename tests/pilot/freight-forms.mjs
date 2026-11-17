import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {writeFileSync} from 'node:fs';
export async function runFreightForms({chromium,base,email,password,restrictedEmail,refs,sql,output,api,keys}) {
 assert.equal(base,'http://127.0.0.1:3100');assert.equal(api.origin,'http://127.0.0.1:54321');
 const company=randomUUID(),sale=randomUUID();
 sql(`insert into public.counterparties(id,roles,legal_name,country) values('${company}',array['carrier'],'Перевозчик браузерного теста','KZ');
 insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
 select '${refs.user}',id,'allow','Synthetic freight browser','${refs.user}' from public.permissions where code in('carriers.directory.read','carriers.directory.manage','freight.context.read','freight.context.manage','drivers.documents.view');
 set session_replication_role=replica;
 insert into public.sales(id,sale_number,customer_id,warehouse_id,planned_shipment_date,created_by) values('${sale}','FREIGHT-BROWSER-SALE','${refs.customer}','${refs.warehouse}',private.business_today()+5,'${refs.user}');
 set session_replication_role=origin;`);
 const business=()=>sql(`select jsonb_build_object('sales',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.sales t),
 'shipments',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.shipments t),
 'stock',(select md5(coalesce(jsonb_agg(to_jsonb(t) order by id)::text,'')) from public.inventory_balances t),
 'movements',(select count(*) from public.inventory_movements),'expenses',(select count(*) from public.expenses),'documents',(select count(*) from public.documents));`);
 const before=business(),browser=await chromium.launch({headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(30000);
 async function login(address){await page.goto(base+'/login');await page.locator('[name=email]').fill(address);await page.locator('[name=password]').fill(password);await page.getByRole('button',{name:'Войти',exact:true}).click();await page.waitForURL(url=>url.pathname!=='/login');}
 async function saveDirectory(){await page.getByRole('button',{name:'Проверить изменения',exact:true}).click();await page.getByRole('button',{name:'Подтвердить изменения',exact:true}).click();
  // The confirmation is shown by the page after it opens the saved record; a refusal is shown at once as an alert.
  const saved=page.getByRole('status').filter({hasText:'Сохранено с историей'}),refused=page.locator('p.login-error[role=alert]');
  await saved.or(refused).first().waitFor();
  if(!await saved.isVisible())throw new Error('Directory save refused: '+await refused.first().innerText());}
 const token=async address=>{const r=await fetch(new URL('/auth/v1/token?grant_type=password',api),{method:'POST',headers:{apikey:keys.ANON_KEY,'Content-Type':'application/json'},body:JSON.stringify({email:address,password})});assert.ok(r.ok);return (await r.json()).access_token;};
 try{
  await login(email);await page.goto(base+'/freight?kind=carrier&new=1');
  await page.getByLabel('Юридическое лицо перевозчика',{exact:true}).selectOption(company);await page.getByLabel('Причина изменения',{exact:true}).fill('Браузерная проверка');await saveDirectory();
  const carrier=sql(`select id from public.carriers where counterparty_id='${company}'`).trim();
  await page.goto(base+'/freight?kind=driver&new=1');await page.getByLabel('ФИО',{exact:true}).fill('Водитель браузерного теста');await page.getByLabel('Телефоны (каждый с новой строки)').fill('+70000000000');await page.getByLabel('Перевозчик',{exact:true}).selectOption(carrier);await page.getByLabel('Причина изменения',{exact:true}).fill('Браузерная проверка');
  await page.getByRole('button',{name:'Проверить изменения',exact:true}).click();await page.getByRole('button',{name:'Вернуться к полям',exact:true}).click();assert.equal(await page.getByLabel('ФИО',{exact:true}).inputValue(),'Водитель браузерного теста');await saveDirectory();
  const driver=sql("select id from public.freight_drivers where full_name='Водитель браузерного теста'").trim();
  const driverSource=JSON.parse(sql("select json_build_object('id',id,'name',driver_name) from public.shipment_transports where nullif(btrim(driver_name),'') is not null order by id limit 1"));
  const driverCount=sql('select count(*) from public.freight_drivers').trim();
  await page.goto(base+`/freight?kind=sources&source_type=transport&source_id=${driverSource.id}`);
  const match=page.getByRole('form',{name:'Сопоставить: Водители',exact:true});
  await match.getByLabel('Уже есть в Nexus: Водители',{exact:true}).selectOption(driver);
  await match.getByRole('button',{name:'Сравнить с существующей записью',exact:true}).click();
  await page.waitForURL(url=>url.searchParams.get('edit')===driver);
  assert.equal(await page.getByLabel('ФИО',{exact:true}).inputValue(),driverSource.name);
  await page.getByLabel('Причина изменения',{exact:true}).fill('Сопоставлено с уже созданным водителем');await saveDirectory();
  assert.equal(sql('select count(*) from public.freight_drivers').trim(),driverCount);
  assert.equal(sql(`select entity_id from private.freight_source_bindings where source_type='transport' and source_id='${driverSource.id}' and kind='driver'`).trim(),driver);
  await page.goto(base+`/freight?kind=driver_documents&edit=${driver}`);await page.getByLabel('ИИН',{exact:true}).fill('123456789012');await page.getByLabel('Реквизиты документа водителя',{exact:true}).fill('FREIGHT-SECRET-SENTINEL');await page.getByLabel('Причина изменения',{exact:true}).fill('Защищённая запись');await saveDirectory();
  await page.goto(base+'/freight?kind=vehicle&new=1');await page.getByLabel('Перевозчик',{exact:true}).selectOption(carrier);await page.getByLabel('Госномер',{exact:true}).fill('TEST-012');await page.getByLabel('Страна регистрации (KZ, PL, RU…)').fill('KZ');await page.getByLabel('Тип транспорта',{exact:true}).selectOption('truck');await page.getByLabel('Статус',{exact:true}).selectOption('active');await page.getByLabel('Причина изменения',{exact:true}).fill('Браузерная проверка');await saveDirectory();
  const vehicle=sql("select id from public.vehicles where plate_number='TEST-012'").trim();
  await page.goto(base+'/freight?kind=trips&mode=sale');await page.getByLabel('FREIGHT-BROWSER-SALE',{exact:true}).check();await page.getByLabel('Перевозчик',{exact:true}).selectOption(carrier);await page.getByLabel('Водитель',{exact:true}).selectOption(driver);await page.getByLabel('Машина',{exact:true}).selectOption(vehicle);await page.getByLabel('Вес пустой паллеты, кг').fill('25');
  const origin=page.getByRole('group',{name:'Погрузка',exact:true}),destination=page.getByRole('group',{name:'Разгрузка',exact:true});
  await origin.getByLabel('Либо полный адрес вручную').fill('Актобе, тестовый адрес');await origin.getByLabel('Ручной адрес проверен').check();await destination.getByLabel('Либо полный адрес вручную').fill('Тестовый адрес покупателя');await destination.getByLabel('Ручной адрес проверен').check();await page.getByLabel('Причина сохранения / изменения').fill('Рейс по тестовым документам');
  await page.getByRole('button',{name:'Предпросмотр рейса',exact:true}).click();await page.getByRole('heading',{name:'Проверьте реквизиты рейса'}).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('FREIGHT-SECRET-SENTINEL'));
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});await page.getByRole('button',{name:'Подтвердить рейс',exact:true}).focus();assert.ok(await page.getByRole('button',{name:'Подтвердить рейс',exact:true}).evaluate(el=>el===document.activeElement));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(output,`freight-preview-${width}.png`),fullPage:true});}
  await page.getByRole('button',{name:'Подтвердить рейс',exact:true}).click();await page.getByRole('status').filter({hasText:'Рейс сохранён'}).waitFor();
  assert.equal(sql(`select count(*) from private.freight_trip_links where sale_id='${sale}'`).trim(),'1');assert.equal(business(),before);
  // A permitted ordinary employee sees driver name, never protected record or private-table API.
  sql(`insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by) select u.id,p.id,'allow','Synthetic freight restricted view','${refs.user}' from public.profiles u cross join public.permissions p where u.id=(select id from auth.users where email='${restrictedEmail}') and p.code in('carriers.directory.read','freight.context.read');`);
  await context.clearCookies();await login(restrictedEmail);await page.goto(base+`/freight?kind=driver&edit=${driver}`);assert.ok((await page.locator('body').innerText()).includes(driverSource.name));assert.ok(!(await page.locator('body').innerText()).includes('123456789012'));
  const access=await token(restrictedEmail);const headers={apikey:keys.ANON_KEY,Authorization:`Bearer ${access}`,'Content-Type':'application/json'};
  const denied=await fetch(new URL('/rest/v1/rpc/freight_directory_detail',api),{method:'POST',headers,body:JSON.stringify({p_kind:'driver_documents',p_id:driver})});assert.equal(denied.status,403);assert.ok(!(await denied.text()).includes('FREIGHT-SECRET-SENTINEL'));
  const hidden=await fetch(new URL('/rest/v1/freight_driver_documents?select=*',api),{headers});assert.ok(!hidden.ok);
  sql(`update public.profiles set user_type='external',counterparty_id='${refs.customer}' where id=(select id from auth.users where email='${restrictedEmail}');`);
  await page.goto(base+'/freight');await page.waitForURL(url=>url.pathname.startsWith('/portal'));
  const portal=await fetch(new URL('/rest/v1/rpc/freight_directory',api),{method:'POST',headers,body:JSON.stringify({p_kind:'driver'})});assert.equal(portal.status,403);
  sql(`update public.profiles set user_type='employee',counterparty_id=null where id=(select id from auth.users where email='${restrictedEmail}');`);
  sql(`update public.user_permission_overrides set effect='deny' where user_id='${refs.user}' and permission_id=(select id from public.permissions where code='carriers.directory.read');`);
  await context.clearCookies();await login(email);await page.goto(base+'/freight');assert.match(await page.locator('body').innerText(),/Недостаточно прав/);assert.equal(await page.getByRole('link',{name:'Добавить запись'}).count(),0);
  assert.equal(business(),before);console.log('PASS freight browser: real Auth, carrier/driver/vehicle forms, preview/back, sale trip, privacy/direct RPC/denial, 1440/390 keyboard, no business effects');
 }catch(error){
  // This runner accepts only the disposable local fixture; no owner documents or credentials.
  await page.screenshot({path:join(output,'freight-failure.png'),fullPage:true}).catch(()=>{});
  writeFileSync(join(output,'freight-failure.txt'),await page.locator('body').innerText().catch(()=>''));
  throw error;
 }finally{await browser.close();sql(`update public.profiles set user_type='employee',counterparty_id=null where id=(select id from auth.users where email='${restrictedEmail}');delete from public.user_permission_overrides where user_id='${refs.user}' and permission_id in(select id from public.permissions where code in('carriers.directory.read','carriers.directory.manage','freight.context.read','freight.context.manage','drivers.documents.view'));`);}
}
