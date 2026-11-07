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
const output = await mkdtemp(join(tmpdir(), 'nexus-clarity-ui-'));
let browser;
let server;
try {
  await new Promise((done, fail) => webpack({
    mode: 'development', devtool: false,
    entry: join(root, 'tests/ui/workflow-clarity.browser.tsx'),
    output: { path: output, filename: 'app.js' },
    plugins: [
      new webpack.DefinePlugin({ 'process.env': JSON.stringify({ NODE_ENV: 'development' }) }),
      new webpack.NormalModuleReplacementPlugin(/^(@\/app\/login\/actions|@\/lib\/auth\/access|\.\/notifications-badge)$/, join(root, 'tests/ui/sidebar-dependencies.tsx')),
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
    await page.getByRole('button', { name: 'Привязать папку', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (width < 900) {
      const menu = page.getByRole('checkbox', { name: 'Показать меню' });
      await menu.focus();
      await page.keyboard.press('Space');
      assert.equal(await menu.isChecked(), true);
      assert.equal(await page.getByRole('link', { name: 'Поступления и поставки' }).isVisible(), true);
      await page.keyboard.press('Space');
      assert.equal(await menu.isChecked(), false);
    }
    assert.equal(await page.locator('#calls').textContent(), '0');

    // Every guide opens with native keyboard controls and fits the narrow layout.
    const sections = await page.getByLabel('Проверяемый раздел').locator('option').evaluateAll(options => options.map(option => option.value));
    for (const section of sections) {
      await page.getByLabel('Проверяемый раздел').selectOption(section);
      await page.locator('.workflow-help > summary').focus();
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.workflow-help').getAttribute('open'), '');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, section);
    }
    await page.getByLabel('Проверяемый раздел').selectOption('shipments');
    await page.locator('.workflow-help > summary').click();
    assert.equal(await page.locator('.operation-tab-list a[aria-current="page"]').innerText(), 'Документы\n7');
    const download = await page.getByRole('link', { name: 'Скачать оригинал' }).first().evaluate(element => ({ color: getComputedStyle(element).color, decoration: getComputedStyle(element).textDecorationLine, href: element.getAttribute('href') }));
    assert.match(download.decoration, /underline/);
    assert.equal(download.color, 'rgb(21, 76, 153)');
    assert.match(download.href, /\/documents\/.+\/download\?version=/);

    await page.getByLabel('Поиск файлов').fill('Нет такого файла');
    await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
    assert.equal(await page.locator('.shipment-drive-file').count(), 2);
    assert.equal(await page.locator('#calls').textContent(), '0', 'help, tabs and filters must not submit');
    assert.match(await page.locator('.processing-status').textContent(), /Ожидает повторения/);

    const submit = page.getByRole('button', { name: 'Сохранить проверочную запись', exact: true });
    await submit.click();
    assert.equal(await page.locator('#calls').textContent(), '0', 'required input stays required');
    await page.getByLabel('Основание', { exact: true }).fill('Синтетическая проверка');
    await page.getByLabel('Отклонить проверочную попытку').check();
    await submit.click();
    const pending = page.getByRole('button', { name: 'Сохраняем…', exact: true });
    await pending.waitFor();
    assert.equal(await pending.isDisabled(), true);
    await pending.evaluate(button => button.click());
    await page.getByText('Проверка отклонена: уточните основание', { exact: true }).waitFor();
    assert.equal(await page.locator('#calls').textContent(), '1', 'pending blocks repeated click');
    assert.deepEqual(JSON.parse(await page.locator('#payload').textContent()), { reason: 'Синтетическая проверка', decision: 'save' });
    assert.equal(await submit.isEnabled(), true, 'server response releases pending');
    assert.equal(await page.getByRole('button', { name: 'Действие без права' }).isDisabled(), true);
    await page.getByLabel('Отклонить проверочную попытку').uncheck();
    await page.getByLabel('Основание', { exact: true }).fill('Повтор после уточнения');
    await submit.click();
    await page.getByText('Проверочная форма выполнена', { exact: true }).waitFor();
    assert.equal(await page.locator('#calls').textContent(), '2');
    assert.deepEqual(errors, []);
    if (process.argv[3]) {
      const screenshots = resolve(process.argv[3]);
      await mkdir(screenshots, { recursive: true });
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(screenshots, `workflow-clarity-${width}.png`), fullPage: true });
    }
    console.log(`PASS ${width}px: ${sections.length} guides, keyboard, overflow, downloads, filters, pending, permissions, validation, retry`);
    await page.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  if (dirname(output) !== resolve(tmpdir()) || !output.startsWith(join(resolve(tmpdir()), 'nexus-clarity-ui-'))) throw Error('UNSAFE_CLEANUP_TARGET');
  await rm(output, { recursive: true, force: true });
}
