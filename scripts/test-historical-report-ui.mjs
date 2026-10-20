// Actual report component fed by the disposable SQL pilot. NOT a full app E2E.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'), req = createRequire(join(root, 'package.json'));
const { chromium } = req(process.argv[2] || 'playwright');
const bundle = req('next/dist/compiled/webpack/webpack');
const capturePath = resolve(root, 'test-results/historical/capture.json');
const capture = await readFile(capturePath);
const parsed = JSON.parse(capture);
assert.ok(parsed.backend && parsed.report && parsed.checkpoints?.length === 6, 'Run the extended SQL pilot first');
const output = await mkdtemp(join(tmpdir(), 'nexus-historical-ui-'));
let browser, server;
try {
  await new Promise((done, fail) => bundle.webpack({
    mode: 'development', devtool: false, entry: join(root, 'tests/pilot/historical-report.browser.tsx'),
    output: { path: output, filename: 'app.js' },
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': join(root, 'src'), 'server-only': false } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/test-tsx-loader.mjs') }] },
  }, (error, stats) => error || stats.hasErrors() ? fail(error || new Error(stats.toString({ all: false, errors: true }))) : done()));
  const js = await readFile(join(output, 'app.js'));
  const css = (await readFile(join(root, 'src/app/globals.css'), 'utf8')).replace(/@import[^;]+;/g, '');
  server = createServer((request, response) => {
    if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); return response.end(js); }
    if (request.url === '/capture.json') { response.setHeader('Content-Type', 'application/json'); return response.end(capture); }
    response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0;padding:16px;font-family:sans-serif}main{max-width:1200px;margin:auto}output{overflow-wrap:anywhere}</style><main id="root"></main><script src="/app.js"></script></html>`);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route('**/*', r => r.request().url().startsWith(url + '/') ? r.continue() : r.abort());
    // Fixed browser time, not a change to business rules or the database clock.
    await context.addInitScript(() => {
      const OriginalDate = Date;
      class FixedDate extends OriginalDate {
        constructor(...args) { super(...(args.length ? args : ['2099-01-20T12:00:00Z'])); }
        static now() { return new OriginalDate('2099-01-20T12:00:00Z').getTime(); }
      }
      globalThis.Date = FixedDate;
    });
    for (const restricted of [false, true]) {
      const pages = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of pages) {
        const errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.goto(url + (restricted ? '/?restricted' : '/'));
        await page.getByTestId('totals').waitFor();
        await page.reload(); await page.getByTestId('totals').waitFor();
        assert.match(await page.getByTestId('totals').innerText(), /Заказано 150; принято 147; автомобили 2; документы 3/);
        const text = await page.locator('body').innerText();
        if (restricted) {
          assert.match(text, /Нет права просматривать склад/);
          assert.doesNotMatch(await page.getByTestId('rpc-calls').innerText(), /purchase_prices|shipment_document_check/);
          assert.doesNotMatch(text, /396,00 EUR/);
        } else {
          assert.match(text, /396,00 EUR/);
          assert.match(text, /PILOT-E2E-A/);
          assert.match(text, /77 шт/);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Page overflow');
        assert.deepEqual(errors, []);
      }
      await mkdir(resolve(root, 'test-results/historical'), { recursive: true });
      await pages[0].screenshot({ path: resolve(root, `test-results/historical/report-${width}-${restricted ? 'restricted' : 'full'}.png`), fullPage: true });
      await Promise.all(pages.map(p => p.close()));
    }
    await context.close();
    console.log(`PASS SQL-backed report component ${width}px: reload, two tabs, price/UI restriction (not auth/RLS proof)`);
  }
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(output, { recursive: true, force: true });
}
