// Real UI components and synthetic form handlers. All external requests are blocked.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { chromium } = require(process.argv[2] || 'playwright');
const { webpack } = require('next/dist/compiled/webpack/webpack');
const output = await mkdtemp(join(tmpdir(), 'nexus-calculator-ui-'));
let browser;
let server;
try {
  await new Promise((done, fail) => webpack({
    mode: 'development', devtool: false,
    entry: join(root, 'tests/ui/calculator-schema.browser.tsx'),
    output: { path: output, filename: 'app.js' },
    plugins: [
      new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) }),
      new webpack.NormalModuleReplacementPlugin(/^\.\/actions$/, resource => { if (resource.context.replaceAll('\\', '/').endsWith('/src/app/products/import')) resource.request = join(root, 'tests/ui/calculator-schema-actions.ts'); }),
    ],
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': join(root, 'src') } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/test-tsx-loader.mjs') }] },
  }, (error, stats) => error || stats.hasErrors() ? fail(error || Error(stats.toString({ all: false, errors: true }))) : done()));
  const js = await readFile(join(output, 'app.js'));
  const css = (await readFile(join(root, 'src/app/globals.css'), 'utf8')).replace(/@import[^;]+;/g, '');
  const assets = new Map();
  for (const [urlPath, file, contentType] of [
    ['/fonts/body.ttf', 'src/app/fonts/GolosText-Variable.ttf', 'font/ttf'],
    ['/fonts/display.ttf', 'src/app/fonts/Jost-Variable.ttf', 'font/ttf'],
    ['/brand/arseo-lion-red.png', 'public/brand/arseo-lion-red.png', 'image/png'],
    ['/brand/nexus.png', 'public/brand/nexus.png', 'image/png'],
  ]) assets.set(urlPath, { data: await readFile(join(root, file)), contentType });
  const fonts = '@font-face{font-family:FixtureBody;src:url(/fonts/body.ttf);font-weight:400 700}@font-face{font-family:FixtureDisplay;src:url(/fonts/display.ttf);font-weight:500 700}:root{--font-body:FixtureBody;--font-display:FixtureDisplay}';
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    const requested = new URL(request.url, 'http://localhost');
    const asset = assets.get(requested.pathname === '/_next/image' ? requested.searchParams.get('url') : requested.pathname);
    if (asset) {
      response.setHeader('Content-Type', asset.contentType);
      response.end(asset.data);
    } else if (request.url === '/app.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(js);
    } else {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${fonts}${css}#payload{display:block;overflow-wrap:anywhere}</style><div id="root"></div><script src="/app.js"></script></html>`);
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => route.request().url().startsWith(url) ? route.continue() : route.abort());
    await page.goto(url);
    const read = page.getByRole('button', { name: 'Прочитать и проверить', exact: true });
    await read.click();
    const approve = page.getByRole('button', { name: 'Подтвердить новые столбцы и проверить', exact: true });
    await approve.waitFor();
    assert.equal(await approve.isDisabled(), true);
    assert.equal(await page.getByText("Доступ: Только с правом на закупочные цены и себестоимость", { exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Синхронизировать с Nexus', exact: true }).count(), 0);
    await page.getByRole('checkbox').check();
    await approve.click();
    await page.getByRole('button', { name: 'Проверка…', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Проверка…', exact: true }).isDisabled(), true);
    const apply = page.getByRole('button', { name: 'Синхронизировать с Nexus', exact: true });
    await apply.waitFor();
    assert.equal(await page.locator('#calls').textContent(), 'preview,approve-schema');
    assert.equal(await page.getByText('Новая структура подтверждена и сохранена в истории.', { exact: false }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await apply.click();
    await page.getByText('Google Таблица синхронизирована:', { exact: false }).waitFor();
    assert.equal(await page.locator('#calls').textContent(), 'preview,approve-schema,apply');
    for (const scenario of ['blocked', 'stale']) {
      await page.goto(url + '?' + scenario);
      await read.click();
      await page.getByRole('heading', { name: 'Изменилась структура калькулятора' }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      if (scenario === 'blocked') assert.equal(await approve.count(), 0);
      else {
        await page.getByRole('checkbox').check();
        await approve.click();
        await page.getByText('Google Таблица изменилась после проверки.', { exact: false }).waitFor();
        assert.equal(await apply.count(), 0);
        await read.click();
        await approve.waitFor();
        assert.equal(await approve.isDisabled(), true, 'A new read requires fresh acknowledgement');
      }
    }
    assert.deepEqual(errors, []);
    if (process.argv[3]) {
      await mkdir(resolve(process.argv[3]), { recursive: true });
      await page.screenshot({ path: join(resolve(process.argv[3]), `calculator-schema-${width}.png`), fullPage: true });
    }
    console.log(`PASS ${width}px: review, consent, pending, preview, separate apply, blocked schema and stale source`);
    await page.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  if (dirname(output) !== resolve(tmpdir()) || !output.startsWith(join(resolve(tmpdir()), 'nexus-calculator-ui-'))) throw Error('UNSAFE_CLEANUP_TARGET');
  await rm(output, { recursive: true, force: true });
}
