// Warehouse operations from a phone (202611280600) on phone sizes (Android and iPhone): the pick of the reserved batch and
// the refusal of another one, the batch asked for when the code names only the product, the shipment of a picked order,
// a move between places, a blind count of a place, receiving with batch and expiry filled from GS1 codes. One column
// without horizontal scroll, buttons for a thumb. Real components, synthetic data; Chromium with each phone's screen.
// Usage: node scripts/test-mobile-operations-ui.mjs [playwright module] [screenshot folder]
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { chromium, devices } = require(process.argv[2] || 'playwright');
const { webpack } = require('next/dist/compiled/webpack/webpack');
const output = await mkdtemp(join(tmpdir(), 'nexus-mobile-operations-ui-'));
let browser, server;
try {
  await new Promise((done, fail) => webpack({ mode: 'development', devtool: false,
    entry: join(root, 'tests/ui/mobile-operations.browser.tsx'), output: { path: output, filename: 'app.js' },
    plugins: [new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': join(root, 'src'), 'next/navigation$': join(root, 'tests/ui/next-navigation.mock.ts'),
      'next/link$': join(root, 'tests/ui/next-link.mock.tsx') } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/test-tsx-loader.mjs') }] },
  }, (error, stats) => error || stats.hasErrors() ? fail(error || Error(stats.toString({ all: false, errors: true }))) : done()));
  const js = await readFile(join(output, 'app.js'));
  const css = (await readFile(join(root, 'src/app/globals.css'), 'utf8')).replace(/@import[^;]+;/g, '');
  const font = await readFile(join(root, 'src/app/fonts/GolosText-Variable.ttf'));
  const fonts = '@font-face{font-family:FixtureBody;src:url(/font.ttf);font-weight:400 700}:root{--font-body:FixtureBody;--font-display:FixtureBody}body{font-family:FixtureBody,sans-serif;margin:0}';
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/font.ttf') { response.setHeader('Content-Type', 'font/ttf'); response.end(font); }
    else if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
    else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts}${css}</style><div id="root"></div><script src="/app.js"></script></html>`); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const scan = async (page, label, code) => {
    const input = page.getByLabel(label);
    await input.click(); await page.keyboard.type(code, { delay: 4 }); await page.keyboard.press('Enter');
  };
  const submitted = page => page.evaluate(() => window.submitted.map(entries => entries));
  const screenshots = { android: ['pick', 'pick-foreign', 'pick-done', 'move', 'count', 'receive', 'receive-expected', 'scan-expected'], iphone: ['pick', 'receive'] };
  for (const [name, device] of [['android', devices['Pixel 7']], ['iphone', devices['iPhone 14']]]) {
    const options = { ...device }; delete options.defaultBrowserType;
    const context = await browser.newContext({ ...options, deviceScaleFactor: Number(process.env.NEXUS_SCREENSHOT_SCALE ?? 1) });
    for (const view of ['pick', 'pick-foreign', 'pick-batch', 'pick-done', 'move', 'count', 'receive', 'receive-expected', 'scan-expected']) {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
      await page.goto(`${url}/?view=${view}`); await page.locator('h1.mobile-title').waitFor();
      if (view === 'pick') {
        const card = await page.locator('.mobile-card-ok').innerText();
        assert.match(card, /Партия совпадает с резервом[\s\S]*SCAN-2 · партия W-2611[\s\S]*место A-02-01 · осталось взять 36 шт\./);
        assert.match(await page.locator('.mobile-hint').first().innerText(), /отобрано строк 1 из 3/);
        await page.getByLabel('Взято, шт.').fill('20');
        await page.getByRole('button', { name: 'Подтвердить отбор' }).click();
        await page.waitForFunction(() => window.submitted.length === 1);
        assert.deepEqual(Object.fromEntries((await submitted(page))[0]), { sale_id: 's1', reservation_id: 'r2', batch_id: 'b2', location_id: 'l2', quantity: '20' },
          'the pick names the reservation, the reserved batch and its place');
        await scan(page, 'Отсканируйте партию, которую берёте', 'NX-3HD8WQ1C');
        assert.deepEqual(await page.evaluate(() => window.pushes), ['/m/pick/s1?via=scanner&code=NX-3HD8WQ1C'], 'the next scan stays on the order');
      }
      if (view === 'pick-foreign') {
        const card = await page.locator('.mobile-card-warning').innerText();
        assert.match(card, /Эта партия не из резерва заказа: W-2507[\s\S]*Возьмите партию W-2611, место A-02-01[\s\S]*сотрудник с правом отступать от FEFO/);
        assert.equal(await page.getByRole('button', { name: 'Подтвердить отбор' }).count(), 0, 'no pick of a foreign batch');
      }
      if (view === 'pick-batch') {
        assert.match(await page.locator('.mobile-card-warning').innerText(), /Нужна партия/);
        assert.equal(await page.getByRole('button', { name: 'Подтвердить отбор' }).count(), 0, 'a product code alone does not confirm the batch');
        assert.equal(await page.getByLabel('Номер партии на упаковке').getAttribute('required'), '');
      }
      if (view === 'pick-done') {
        assert.match(await page.locator('.mobile-card-ok').innerText(), /Всё отобрано/);
        assert.equal(await page.getByLabel('Отсканируйте партию, которую берёте').count(), 0, 'nothing left to scan');
        await page.getByRole('button', { name: 'Отгрузить заказ' }).click();
        await page.waitForFunction(() => window.submitted.length === 1);
        assert.deepEqual((await submitted(page))[0], [['sale_id', 's1']]);
      }
      if (view === 'move') {
        assert.match(await page.locator('.mobile-card').first().innerText(), /A-02-01 · SCAN-2[\s\S]*свободно 24 из 60 шт\./);
        assert.equal(await page.getByLabel('Сколько, шт.').inputValue(), '24', 'free stock offered, the reserved part stays');
        await page.getByRole('button', { name: 'Переместить' }).click();
        await page.waitForFunction(() => window.submitted.length === 1);
        assert.deepEqual(Object.fromEntries((await submitted(page))[0]), { balance_id: 'bal', to_location_id: 'l4', quantity: '24', note: '' });
      }
      if (view === 'count') {
        const text = await page.locator('main').innerText();
        assert.match(text, /Подсчёт ИНВ-000014[\s\S]*слепой: учётного количества здесь нет/);
        assert.match(text, /Посчитано на месте[\s\S]*SCAN-2[\s\S]*3\s*кор\. · записей 1/);
        assert.equal(await page.getByLabel('Единица').inputValue(), 'box', 'the box code counts in boxes');
        assert.equal(await page.getByLabel('Партия').inputValue(), 'b1');
        await page.getByLabel('Количество').fill('4');
        await page.getByRole('button', { name: 'Записать' }).click();
        await page.waitForFunction(() => window.submitted.length === 1);
        assert.deepEqual(Object.fromEntries((await submitted(page))[0]),
          { count_id: 'c1', round: '1', location_id: 'l1', product_id: 'p1', batch_id: 'b1', uom: 'box', quantity: '4', note: '' });
      }
      if (view === 'receive') {
        const label = 'Сканируйте коробку: партия и срок подставятся';
        await scan(page, label, '(01)04601234567893(10)LOT-91(17)280131');
        assert.match(await page.getByRole('status').innerText(), /SCAN-1 · Шоколад молочный 90 г: партия LOT-91, срок 31\.01\.2028 подставлены/);
        await scan(page, label, '(01)04601234567893(10)LOT-92(17)280229');
        assert.match(await page.getByRole('status').innerText(), /новая партия, партия LOT-92, срок 29\.02\.2028/);
        await scan(page, label, '4607000000014');
        assert.match(await page.getByRole('status').innerText(), /SCAN-2 · Вафли ореховые 150 г: введите партию и срок/);
        await scan(page, label, '2000000000001');
        assert.match(await page.getByRole('status').innerText(), /не относится к товарам этого автомобиля/);
        await scan(page, label, '(01)04601234567890(10)X');
        assert.match(await page.getByRole('status').innerText(), /контрольн/i, 'a wrong GTIN is not guessed');
        assert.equal(await page.evaluate(() => window.pushes.length), 0, 'receiving scans fill the form, they open nothing');
        const first = page.locator('#receive-i1');
        await first.getByLabel('По документу').first().fill('200'); await first.getByLabel('Принято').first().fill('200');
        await first.getByLabel('По документу').nth(1).fill('40'); await first.getByLabel('Принято').nth(1).fill('40');
        await page.locator('#receive-i2').getByLabel('Номер партии').fill('W-2611');
        await page.locator('#receive-i2').getByLabel('Годен до').fill('2027-06-15');
        await page.getByRole('button', { name: 'Завершить приёмку' }).click();
        await page.waitForFunction(() => window.submitted.length === 1);
        const form = (await submitted(page))[0];
        const all = key => form.filter(([field]) => field === key).map(([, value]) => value);
        assert.deepEqual(all('item_id'), ['i1', 'i1', 'i2']);
        assert.deepEqual(all('batch_number'), ['LOT-91', 'LOT-92', 'W-2611']);
        assert.deepEqual(all('expiry_date'), ['2028-01-31', '2028-02-29', '2027-06-15']);
        assert.deepEqual(all('expected_quantity'), ['200', '40', '120']);
      }
      if (view === 'receive-expected') {
        const item = page.locator('#receive-i1');
        assert.match(await item.innerText(), /Партия 1 · наклейка NX-4WQ7M2KD[\s\S]*Партия 2 · наклейка NX-9HT3B6RE/, 'one row per batch of the packing list');
        assert.equal(await item.getByLabel('Номер партии').first().inputValue(), '2611-01-07');
        assert.equal(await item.getByLabel('Годен до').first().inputValue(), '2027-11-30');
        assert.equal(await item.getByLabel('Принято').nth(1).inputValue(), '800');
        await scan(page, 'Сканируйте коробку: партия и срок подставятся', 'NX-9HT3B6RE');
        assert.match(await page.getByRole('status').innerText(), /партия 2611-01-08 — строка 2, проверьте количество и срок/);
        await scan(page, 'Сканируйте коробку: партия и срок подставятся', 'NX-0000ZZZZ');
        assert.match(await page.getByRole('status').innerText(), /Наклейка не из упаковочного листа этой машины/);
        await item.getByLabel('Принято').first().fill('1190');
        await item.getByLabel('Причина расхождения').first().fill('Недостача 10');
        await item.getByLabel('Годен до').nth(1).fill('2027-12-15');
        await page.getByRole('button', { name: 'Завершить приёмку' }).click();
        await page.waitForFunction(() => window.submitted.length === 1);
        const form = (await submitted(page))[0];
        const all = key => form.filter(([field]) => field === key).map(([, value]) => value);
        assert.deepEqual(all('batch_number'), ['2611-01-07', '2611-01-08']);
        assert.deepEqual(all('expected_quantity'), ['1200', '800']);
        assert.deepEqual(all('accepted_quantity'), ['1190', '800']);
        assert.deepEqual(all('expiry_date'), ['2027-11-30', '2027-12-15']);
      }
      if (view === 'scan-expected') {
        const card = await page.locator('.mobile-card').innerText();
        assert.match(card, /NUT-13 · партия 2611-01-07[\s\S]*по листу 1[\s\u00a0]200[\s\S]*Поставка NAR-2026-0118, машина №2[\s\S]*не совпали с упаковочным листом: наклейка не привязана[\s\S]*Срок по упаковочному листу 30\.11\.2027/);
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}/${view}: no horizontal scroll`);
      for (const button of await page.locator('button.scan-button:visible').all()) {
        assert.ok((await button.boundingBox()).height >= 44, `${name}/${view}: buttons large enough for a thumb`);
      }
      if (process.argv[3] && screenshots[name].includes(view)) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await mkdir(resolve(process.argv[3]), { recursive: true });
        await page.screenshot({ path: join(resolve(process.argv[3]), `mobile-ops-${name}-${view}.png`), fullPage: true });
      }
      assert.deepEqual(errors, []);
      await page.close();
    }
    await context.close();
  }
  // The page of a shipment with the batches of its packing list (202611280700), on a desktop screen.
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: Number(process.env.NEXUS_SCREENSHOT_SCALE ?? 1) });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    await page.goto(`${url}/?view=shipment-batches`); await page.getByRole('heading', { name: 'Партии из упаковочного листа' }).waitFor();
    const text = await page.locator('main').innerText();
    assert.match(text, /Партия 2611-01-09 · HAZELNUT KERNELS 13-15/);
    assert.match(text, /A-5502[\s\S]*не совпала с листом[\s\S]*Срок по упаковочному листу 30\.11\.2027/);
    assert.equal(await page.getByLabel('Позиция поставки').inputValue(), 'i1', 'the only truck not received is chosen');
    assert.equal(await page.getByRole('checkbox', { name: 'Печатать наклейку партии 2611-01-99' }).count(), 0, 'a cancelled batch is not printed');
    assert.equal(await page.getByRole('checkbox', { name: 'Печатать наклейку партии 2611-01-08' }).isChecked(), true, 'not yet printed: offered');
    assert.equal(await page.getByRole('checkbox', { name: 'Печатать наклейку партии 2611-01-07' }).isChecked(), false, 'printed already: not offered again');
    assert.equal(await page.getByLabel('Наклеек партии 2611-01-08').inputValue(), '4');
    const form = await page.evaluate(() => [...new FormData(document.getElementById('print-labels')).entries()].map(([key, value]) => [key, String(value)]));
    assert.deepEqual(form.filter(([key]) => key === 'ids').map(([, value]) => value), ['e2'], 'the checkboxes in the tables belong to the print form');
    assert.ok(form.some(([key, value]) => key === 'copies_e2' && value === '4'));
    assert.equal(await page.locator('#item-i2 form.reference-form').count(), 0, 'no batch is added to a truck already received');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'desktop: no horizontal scroll');
    if (process.argv[3]) await page.screenshot({ path: join(resolve(process.argv[3]), 'shipment-batches-1440.png'), fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log('PASS mobile operations UI (Pixel 7, iPhone 14, desktop): reserved batch only, ship when picked, move, blind count, GS1 receiving, packing list labels');
} finally {
  await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true });
}
