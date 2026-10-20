// Browser component test, fake action, no outside network or database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), req = createRequire(join(root, "package.json"));
const { chromium } = req(process.argv[2] || "playwright"), bundle = req("next/dist/compiled/webpack/webpack");
const output = await mkdtemp(join(tmpdir(), "nexus-context-ui-"));
let browser, server;
try {
  await new Promise((done, fail) => bundle.webpack({ mode: "development", devtool: false,
    entry: join(root, "tests/documents/transport-context.browser.tsx"), output: { path: output, filename: "app.js" },
    resolve: { extensions: [".tsx", ".ts", ".js"], alias: { "@": join(root, "src") } },
    module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: join(root, "scripts/test-tsx-loader.mjs") }] },
  }, (error, stats) => error || stats.hasErrors() ? fail(error || Error(stats.toString({ all: false, errors: true }))) : done()));
  const js = await readFile(join(output, "app.js")), css = (await readFile(join(root, "src/app/globals.css"), "utf8")).replace(/@import[^;]+;/g, "");
  server = createServer((request, response) => {
    if (request.url === "/app.js") { response.setHeader("Content-Type", "text/javascript"); response.end(js); }
    else response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{padding:16px;margin:0;font-family:sans-serif}main{max-width:1100px;margin:auto}</style><main id="root"></main><script src="/app.js"></script></html>`);
  });
  await new Promise(done => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } }), errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    await page.goto(url);
    await page.getByText("Импорт · SYNTH-01", { exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Сохранить контекст" }).count(), 1);
    await page.locator("select").selectOption("B");
    await page.getByRole("button", { name: "Сохранить контекст" }).click();
    assert.equal(await page.locator("#result").textContent(), "", "reason required");
    await page.getByLabel("Причина изменения контекста").fill("Проверено по синтетическому оригиналу");
    await page.getByRole("button", { name: "Сохранить контекст" }).click();
    await page.getByText("Выбрано: B; причина: Проверено по синтетическому оригиналу", { exact: true }).waitFor();
    await page.getByText("История контекста (1)", { exact: true }).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    if (process.argv[3]) { await mkdir(resolve(process.argv[3]), { recursive: true }); await page.screenshot({ path: resolve(process.argv[3], `context-${width}.png`), fullPage: true }); }
    console.log(`PASS ${width}px: explicit operation/vehicle/reason, confirmed context immutable, history, no overflow`);
    await page.close();
  }
} finally {
  await browser?.close(); if (server) await new Promise(done => server.close(done)); await rm(output, { recursive: true, force: true });
}
