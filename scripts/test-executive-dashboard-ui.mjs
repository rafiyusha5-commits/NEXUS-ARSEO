// Real React tiles of the executive dashboard with synthetic data (202611280400): every tile renders, a failed source says
// "нет данных" (never a zero), and on a phone the tiles stand in one column without horizontal scroll.
// Usage: node scripts/test-executive-dashboard-ui.mjs [playwright module] [screenshot folder]
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
const output = await mkdtemp(join(tmpdir(), 'nexus-dashboard-ui-'));
let browser, server;
try {
  await new Promise((done, fail) => webpack({ mode: 'development', devtool: false,
    entry: join(root, 'tests/ui/executive-dashboard.browser.tsx'), output: { path: output, filename: 'app.js' },
    plugins: [new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': join(root, 'src'), 'next/link$': join(root, 'tests/ui/next-link.mock.tsx') } },
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
  browser = await chromium.launch({ headless: true, ...(process.env.NEXUS_TEST_BROWSER_CHANNEL ? { channel: process.env.NEXUS_TEST_BROWSER_CHANNEL } : {}) });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: Number(process.env.NEXUS_SCREENSHOT_SCALE ?? 1) });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    await page.goto(url); await page.getByRole('heading', { name: 'Дашборд', exact: true }).waitFor();
    assert.equal(await page.locator('.executive-tile').count(), 7);
    const failed = page.locator('.executive-tile-error');
    assert.equal(await failed.count(), 1);
    assert.match(await failed.innerText(), /Поставки[\s\S]*нет данных/);
    assert.doesNotMatch(await failed.innerText(), /\b0\b/, 'a failed tile shows no zero');
    assert.equal(await failed.getByRole('link', { name: 'Открыть отчёт →' }).getAttribute('href'), '/analytics');
    assert.equal(await page.locator('.executive-badge').count(), 2, 'incomplete data is marked');
    assert.match(await page.locator('.executive-attention').innerText(), /Кассовый разрыв в EUR с 10\.12[\s\S]*Поставки: нет данных/);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `no horizontal scroll at ${width}`);
    if (width === 390) {
      const lefts = await page.locator('.executive-tile').evaluateAll(nodes => [...new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left)))]);
      assert.equal(lefts.length, 1, 'one column on a phone');
    }
    if (process.argv[3]) { await mkdir(resolve(process.argv[3]), { recursive: true }); await page.screenshot({ path: join(resolve(process.argv[3]), `executive-dashboard-${width}.png`), fullPage: true }); }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS executive dashboard UI: 7 tiles, a failed source without a zero, one column without horizontal scroll on a phone');
} finally {
  await browser?.close(); server?.close(); await rm(output, { recursive: true, force: true });
}
