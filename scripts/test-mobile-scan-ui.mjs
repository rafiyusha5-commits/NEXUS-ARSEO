// The mobile lookup by code (202611280500) on phone sizes (Android and iPhone): a scanner (fast keys and Enter) and typing
// are told apart, a GS1 code opens the lookup with its parts, results stand in one column without horizontal scroll.
// Real components, synthetic data; Chromium with the viewport and user agent of each phone.
// Usage: node scripts/test-mobile-scan-ui.mjs [playwright module] [screenshot folder]
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
const output = await mkdtemp(join(tmpdir(), 'nexus-mobile-scan-ui-'));
let browser, server;
try {
  await new Promise((done, fail) => webpack({ mode: 'development', devtool: false,
    entry: join(root, 'tests/ui/mobile-scan.browser.tsx'), output: { path: output, filename: 'app.js' },
    plugins: [new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': join(root, 'src'), 'next/navigation$': join(root, 'tests/ui/next-navigation.mock.ts') } },
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
  for (const [name, device] of [['android', devices['Pixel 7']], ['iphone', devices['iPhone 14']]]) {
    const options = { ...device }; delete options.defaultBrowserType;
    const context = await browser.newContext({ ...options, deviceScaleFactor: Number(process.env.NEXUS_SCREENSHOT_SCALE ?? 1) });
    for (const view of ['product', 'location', 'unknown']) {
      const page = await context.newPage();
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
      await page.goto(`${url}/?view=${view}`); await page.getByRole('heading', { name: 'Поиск по коду' }).waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}/${view}: no horizontal scroll`);
      if (view === 'product') {
        assert.match(await page.locator('.mobile-card').innerText(), /Шоколад[\s\S]*коробка \(12 шт\.\)[\s\S]*20[\s\S]*свободно из 30/);
        const input = page.getByLabel('Код: отсканируйте или введите');
        await input.click(); await page.keyboard.type('4601234567893', { delay: 4 }); await page.keyboard.press('Enter');
        await input.click(); await page.keyboard.type('4601234567893', { delay: 140 }); await page.keyboard.press('Enter');
        await input.click(); await page.keyboard.type('(01)04601234567893(10)LOT-77(17)270330', { delay: 4 }); await page.keyboard.press('Enter');
        const pushes = await page.evaluate(() => window.pushes);
        assert.deepEqual(pushes, ['/m/scan?via=scanner&code=4601234567893', '/m/scan?via=manual&code=4601234567893',
          '/m/scan?via=scanner&code=04601234567893&batch=LOT-77&expiry=2027-03-30'], 'scanner and typing told apart; GS1 split into its parts');
        await page.evaluate(() => { window.pushes = []; document.getElementById('pushes').textContent = ''; });
      }
      if (view === 'unknown') {
        assert.match(await page.locator('.mobile-card').innerText(), /Код не найден/);
        assert.equal(await page.getByLabel('Я проверил: этот код на упаковке выбранного товара').getAttribute('required'), '', 'binding needs the confirmation');
      }
      const box = await page.getByRole('button', { name: 'Найти' }).boundingBox();
      assert.ok(box.height >= 44, 'buttons large enough for a thumb');
      if (process.argv[3]) { await mkdir(resolve(process.argv[3]), { recursive: true }); await page.screenshot({ path: join(resolve(process.argv[3]), `mobile-scan-${name}-${view}.png`), fullPage: true }); }
      assert.deepEqual(errors, []);
      await page.close();
    }
    await context.close();
  }
  console.log('PASS mobile scan UI (Pixel 7, iPhone 14): scanner vs typing, GS1 parts, one column without horizontal scroll');
} finally {
  await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true });
}
