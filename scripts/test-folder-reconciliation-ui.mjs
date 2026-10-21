// Actual screen, synthetic actions; outbound requests blocked. No Supabase/Drive process.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), req = createRequire(join(root, "package.json"));
const { chromium } = req(process.argv[2] || "playwright");
const bundle = req("next/dist/compiled/webpack/webpack");
const output = await mkdtemp(join(tmpdir(), "nexus-folder-ui-"));
let browser, server;
try {
  await new Promise((done, fail) => bundle.webpack({ mode: "development", devtool: false,
    plugins: [new bundle.webpack.DefinePlugin({ "process.env": JSON.stringify({ NODE_ENV: "development" }) })],
    entry: join(root, "tests/documents/folder-reconciliation.browser.tsx"), output: { path: output, filename: "app.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": join(root, "src") } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, "scripts/test-tsx-loader.mjs") }] },
  }, (error, stats) => error || stats.hasErrors() ? fail(error || Error(stats.toString({ all: false, errors: true }))) : done()));
  const js = await readFile(join(output, "app.js"));
  const css = (await readFile(join(root, "src/app/globals.css"), "utf8")).replace(/@import[^;]+;/g, "");
  server = createServer((request, response) => {
    if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(js); }
    else response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{padding:16px;margin:0}main{max-width:1100px;margin:auto}</style><main id="root"></main><script src="/app.js"></script></html>`);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }), errors = [];
    page.on("pageerror", e => { errors.push(e.message); console.error(e.message); });
    await page.route("**/*", r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    await page.goto(url);
    await page.getByText("Показано 250 из 250", { exact: true }).waitFor();
    assert.equal(await page.locator("#result").textContent(), "");
    await page.getByLabel("Состояние", { exact: true }).selectOption("exact");
    await page.getByText("Показано 1 из 250", { exact: true }).waitFor();
    await page.getByLabel("Подпапка", { exact: true }).selectOption("Закупка");
    await page.getByText("Показано 0 из 250", { exact: true }).waitFor();
    await page.getByLabel("Подпапка", { exact: true }).selectOption("");
    await page.getByLabel("Поиск файлов").fill("инвойс");
    await page.getByText("Показано 1 из 250", { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "mobile page overflow");
    if (process.argv[3]) { await mkdir(resolve(process.argv[3]), { recursive: true }); await page.screenshot({ path: resolve(process.argv[3], `folder-${width}.png`), fullPage: true }); }
    await page.getByLabel("Проверил назначение документа для этой поставки").check();
    await page.getByRole("button", { name: "Связать с существующим документом" }).click();
    await page.getByText("Выбрана явная операция", { exact: true }).waitFor();
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: 250 files, search, status/folder filters, explicit link, no overflow`);
    await page.close();
  }
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  await rm(output, { recursive: true, force: true });
}
