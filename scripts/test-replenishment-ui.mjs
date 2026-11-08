// Real React forms; synthetic handlers. SQL/RLS and transaction tests run separately on PostgreSQL 16.
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
const output = await mkdtemp(join(tmpdir(), 'nexus-replenishment-ui-'));
let browser, server;
try {
  await new Promise((done, fail) => webpack({ mode: 'development', devtool: false,
    entry: join(root, 'tests/ui/replenishment.browser.tsx'), output: { path: output, filename: 'app.js' },
    plugins: [new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) })],
    resolve: { extensions: ['.tsx', '.ts', '.js'], alias: { '@': join(root, 'src') } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, 'scripts/test-tsx-loader.mjs') }] },
  }, (error, stats) => error || stats.hasErrors() ? fail(error || Error(stats.toString({ all: false, errors: true }))) : done()));
  const js = await readFile(join(output, 'app.js'));
  const css = (await readFile(join(root, 'src/app/globals.css'), 'utf8')).replace(/@import[^;]+;/g, '');
  const font = await readFile(join(root, 'src/app/fonts/GolosText-Variable.ttf'));
  const fonts = '@font-face{font-family:FixtureBody;src:url(/font.ttf);font-weight:400 700}:root{--font-body:FixtureBody;--font-display:FixtureBody}body{font-family:FixtureBody,sans-serif}';
  server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/font.ttf') { response.setHeader('Content-Type', 'font/ttf'); response.end(font); }
    else if (request.url === '/app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(js); }
    else if (request.url.startsWith('/replenishment/explain')) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ explanation: 'Проверочное пояснение, не вызов внешней модели.' })); }
    else { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${fonts}${css}</style><div id="root"></div><script src="/app.js"></script></html>`); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.NEXUS_TEST_BROWSER_CHANNEL ? { channel: process.env.NEXUS_TEST_BROWSER_CHANNEL } : {}) });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    await page.goto(url); await page.getByRole('heading', { name: 'Автозаказ Казахстан', exact: true }).waitFor();
    assert.equal(await page.locator('tbody tr').count(), 2);
    assert.ok((await page.locator('tbody').innerText()).includes('140'));
    assert.ok((await page.locator('tbody').innerText()).includes('70'));
    const draft = page.getByRole('button', { name: 'Подготовить черновик прогноза', exact: true });
    await draft.click(); assert.equal(await page.locator('#payload').textContent(), '', 'required reason blocks empty submit');
    await page.getByLabel('Причина подготовки прогноза', { exact: true }).fill('Спрос проверен на синтетических данных');
    await draft.click(); await page.waitForFunction(() => document.querySelector('#payload').textContent.includes('forecast'));
    assert.equal(await page.getByRole('link', { name: 'Подготовить сообщение WhatsApp' }).count(), 0);
    await page.getByLabel('Я проверю файл и получателя перед отправкой').check();
    assert.match(await page.getByRole('link', { name: 'Подготовить сообщение WhatsApp' }).getAttribute('href'), /^https:\/\/wa.me\/\?text=/);
    const download = page.getByRole('link', { name: 'Скачать Excel с расчётом и основаниями' });
    const style = await download.evaluate(el => ({ color: getComputedStyle(el).color, decoration: getComputedStyle(el).textDecorationLine }));
    assert.equal(style.color, 'rgb(7, 85, 176)'); assert.ok(style.decoration.includes('underline'));
    await page.getByRole('button', { name: 'Объяснить результат с помощью ИИ' }).click();
    await page.getByText('Пояснение модели — проверьте по таблице', { exact: true }).waitFor();
    await page.getByLabel('Сценарий').selectOption('unknown'); assert.equal(await draft.isDisabled(), true);
    await page.getByText('Нет истории: задайте стартовый спрос, в том числе ноль с причиной', { exact: true }).first().waitFor();
    await page.getByLabel('Сценарий').selectOption('stale'); assert.equal(await draft.isDisabled(), true); assert.equal(await download.count(), 0);
    await page.getByLabel('Сценарий').selectOption('ready');
    if (process.argv[3]) { await mkdir(resolve(process.argv[3]), { recursive: true }); await page.screenshot({ path: join(resolve(process.argv[3]), `replenishment-${width}.png`), fullPage: true }); }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'table scroll stays inside its container');
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: separate cities, reasons, draft, stale/unknown guards, Excel, explicit share, model label, no external calls`);
    await page.close();
  }
} finally {
  await browser?.close(); if (server) await new Promise(done => server.close(done));
  if (dirname(output) !== resolve(tmpdir()) || !output.startsWith(join(resolve(tmpdir()), 'nexus-replenishment-ui-'))) throw Error('UNSAFE_CLEANUP_TARGET');
  await rm(output, { recursive: true, force: true });
}
