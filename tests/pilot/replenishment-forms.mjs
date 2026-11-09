// Only called by the disposable local Supabase runner, with its generated account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export async function runReplenishmentForms({ chromium, base, email, password, restrictedEmail, refs, sql, output }) {
  assert.equal(base, 'http://127.0.0.1:3100');
  const ids = Object.fromEntries(['supplier', 'product', 'aktobe', 'astana', 'almaty', 'batch', 'balance'].map(k => [k, randomUUID()]));
  sql(`insert into public.counterparties(id,roles,legal_name,country) values('${ids.supplier}',array['manufacturer','supplier'],'Browser replenishment supplier','FI');
    insert into public.warehouses(id,code,name,city,country) values
    ('${ids.aktobe}','AUTO-ACT','{"ru":"Автозаказ Актобе"}','Актобе','KZ'),
    ('${ids.astana}','AUTO-AST','{"ru":"Автозаказ Астана"}','Астана','KZ'),
    ('${ids.almaty}','AUTO-ALA','{"ru":"Автозаказ Алматы"}','Алматы','KZ');
    insert into public.products(id,internal_sku,name,manufacturer_id,status,shelf_life_days) values('${ids.product}','AUTO-001','{"ru":"Тест автозаказа"}','${ids.supplier}','active',540);
    insert into public.product_packaging(product_id,uom,units_per_parent) values('${ids.product}','box',10);
    set session_replication_role=replica;
    insert into public.inventory_batches(id,product_id,batch_number,expiry_date,status,created_by) values('${ids.batch}','${ids.product}','AUTO-LOT',private.business_today()+500,'available','${refs.user}');
    insert into public.inventory_balances(id,batch_id,warehouse_id,uom,quantity_on_hand,quantity_reserved) values('${ids.balance}','${ids.batch}','${ids.aktobe}','piece',100,0);
    set session_replication_role=origin;`);
  const business = () => sql(`select json_build_object('qty',(select quantity_on_hand from public.inventory_balances where id='${ids.balance}'),'reserved',(select quantity_reserved from public.inventory_balances where id='${ids.balance}'),'movements',(select count(*) from public.inventory_movements),'sales',(select count(*) from public.sales),'shipments',(select count(*) from public.shipments));`).trim();
  const before = business();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', r => new URL(r.request().url()).origin === base ? r.continue() : r.abort());
  const page = await context.newPage(); page.setDefaultTimeout(25000);
  const form = label => page.locator('form').filter({ has: page.getByRole('button', { name: label, exact: true }) });
  async function submit(label) {
    const pending = page.waitForResponse(r => r.request().method() === 'POST' && r.url().startsWith(base));
    await page.getByRole('button', { name: label, exact: true }).click();
    const response = await pending;
    const redirect = response.headers()['x-action-redirect']?.split(';')[0] ?? response.headers().location;
    if (redirect) await page.waitForURL(new URL(redirect, base).href);
    await page.waitForLoadState('networkidle');
    const url = new URL(page.url());
    for (const key of ['error', 'message']) assert.equal(url.searchParams.get(key), null, url.searchParams.get(key));
  }
  async function login(address) {
    await page.goto(base + '/login'); await page.locator('[name="email"]').fill(address); await page.locator('[name="password"]').fill(password); await submit('Войти');
  }
  try {
    await login(email); await page.goto(base + '/replenishment');
    const config = form('Сохранить отдельную версию настроек');
    await config.locator('[name="name"]').fill('Browser KZ settings');
    for (const key of ['supplier', 'aktobe', 'astana', 'almaty']) await config.locator(`[name="${key}"]`).selectOption(ids[key]);
    await config.locator('[name="reason"]').fill('Synthetic delivery lead times');
    await submit('Сохранить отдельную версию настроек');
    assert.ok(await page.getByText('Нет истории: задайте стартовый спрос, в том числе ноль с причиной', { exact: true }).count());
    await submit('Пересчитать и сохранить новую версию');
    const unknownRun = new URL(page.url()).searchParams.get('run'); assert.match(unknownRun, /^[0-9a-f-]{36}$/);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.deepEqual(await page.locator('#result tbody tr td:nth-child(2)').allTextContents(), ['Спрос неизвестен', 'Спрос неизвестен']);
      assert.deepEqual(await page.locator('#result tbody tr td:nth-child(5)').allTextContents(), ['Закупка не рассчитана', 'Закупка не рассчитана']);
      for (const label of ['Подготовить черновик прогноза', 'Подготовить черновик плана закупки']) assert.equal(await page.getByRole('button', { name: label, exact: true }).isDisabled(), true);
    }
    assert.equal((await context.request.get(base + '/replenishment/export?run=' + unknownRun)).status(), 409);
    assert.equal(Number(sql(`select count(*) from public.replenishment_decisions where run_id='${unknownRun}';`)), 0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByText('Новая версия настроек и стартовый спрос', { exact: true }).click();
    await config.locator(`[name="${ids.product}:astana"]`).fill('10');
    await config.locator(`[name="${ids.product}:astana:reason"]`).fill('Synthetic new product demand');
    await config.locator(`[name="${ids.product}:almaty"]`).fill('5');
    await config.locator(`[name="${ids.product}:almaty:reason"]`).fill('Synthetic new product demand');
    await config.locator('[name="reason"]').fill('Synthetic explicit demand version');
    await submit('Сохранить отдельную версию настроек');
    await page.locator('#supply details summary').click();
    await form('Сохранить назначение').locator('[name="kz"]').fill('100');
    await form('Сохранить назначение').locator('[name="reason"]').fill('Synthetic domestic stock');
    await submit('Сохранить назначение');
    await submit('Пересчитать и сохранить новую версию');
    const run = new URL(page.url()).searchParams.get('run'); assert.match(run, /^[0-9a-f-]{36}$/);
    await form('Подготовить черновик прогноза').locator('[name="reason"]').fill('Reviewed synthetic forecast');
    await submit('Подготовить черновик прогноза');
    const forecast = new URL(page.url()).searchParams.get('forecast'); assert.match(forecast, /^[0-9a-f-]{36}$/);
    // A newer unrelated draft must not hijack a link from the saved calculation.
    const unrelated = form('Создать прогноз');
    await unrelated.locator('[name="name"]').fill('Unrelated later forecast');
    await unrelated.locator('[name="horizon_start"]').fill(sql("select date_trunc('month',private.business_today())::date;").trim());
    await unrelated.locator('[name="horizon_end"]').fill(sql('select private.business_today()+90;').trim());
    await submit('Создать прогноз');
    assert.notEqual(new URL(page.url()).searchParams.get('forecast'), forecast);
    await page.goto(base + '/replenishment?run=' + run);
    await page.getByRole('link', { name: 'Открыть прогноз', exact: true }).click();
    await page.waitForLoadState('networkidle');
    assert.equal(new URL(page.url()).searchParams.get('forecast'), forecast);
    assert.equal(await form('Отправить на проверку').locator('[name="p_forecast_id"]').inputValue(), forecast);
    await submit('Отправить на проверку'); await submit('Коммерчески проверено'); await submit('Утвердить версию');
    await page.goto(base + '/replenishment?run=' + run);
    await form('Подготовить черновик плана закупки').locator('[name="reason"]').fill('Reviewed synthetic purchase');
    await form('Подготовить черновик плана закупки').locator('[name="use_existing_kz"]').check();
    await submit('Подготовить черновик плана закупки');
    const plan = new URL(page.url()).searchParams.get('plan'); assert.match(plan, /^[0-9a-f-]{36}$/);
    assert.equal(await form('На логистическую проверку').locator('[name="p_plan_id"]').inputValue(), plan);
    assert.equal(sql(`select status from public.purchase_plans where id='${plan}';`).trim(), 'draft');
    assert.equal(Number(sql(`select count(*) from public.replenishment_decisions where run_id='${run}';`)), 2);
    await page.goto(base + '/replenishment?run=' + run);
    const exportResponse = await context.request.get(base + '/replenishment/export?run=' + run);
    assert.equal(exportResponse.status(), 200); assert.equal((await exportResponse.body()).subarray(0, 2).toString(), 'PK');
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: join(output, `replenishment-auth-${width}.png`), fullPage: true });
    }
    assert.equal(business(), before, 'planning changed operating data');
    sql(`update public.inventory_balances set updated_at=clock_timestamp() where id='${ids.balance}';`);
    assert.equal((await context.request.get(base + '/replenishment/export?run=' + run)).status(), 409);
    await page.reload(); assert.ok(await page.getByText('Данные изменились или наступил новый рабочий день.', { exact: false }).count());
    assert.equal(await page.getByRole('button', { name: 'Подготовить черновик плана закупки', exact: true }).isDisabled(), true);
    sql(`insert into public.user_permission_overrides(user_id,permission_id,effect,reason,granted_by)
      select u.id,p.id,'deny','Synthetic replenishment access test','${refs.user}' from auth.users u cross join public.permissions p where u.email='${restrictedEmail}' and p.code='customers.view';`);
    await context.clearCookies(); await login(restrictedEmail);
    assert.equal((await context.request.get(base + '/replenishment/export?run=' + run)).status(), 403);
    writeFileSync(join(output, 'replenishment-auth.json'), JSON.stringify({ fullAuthenticatedFlow: true, separateLocalSupabase: true, forecastApproval: true, purchaseDraft: true, businessUnchanged: true, staleBlocked: true, accessDenied: true }, null, 2));
    console.log('PASS authenticated replenishment: configure, classify stock, calculate, approve forecast, prepare draft, download XLSX, stale and permission guards');
  } finally { await context.close(); await browser.close(); }
}
