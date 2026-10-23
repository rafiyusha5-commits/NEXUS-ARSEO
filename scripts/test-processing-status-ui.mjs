// Pure synthetic browser fixture. All external requests blocked, no owner database.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), req = createRequire(join(root, "package.json"));
const { chromium } = req(process.argv[2] || "playwright"), bundle = req("next/dist/compiled/webpack/webpack");
const output = await mkdtemp(join(tmpdir(), "nexus-status-ui-"));
let browser, server;
try {
  await new Promise((done, fail) => bundle.webpack({ mode: "development", devtool: false,
    entry: join(root, "tests/documents/processing-status.browser.tsx"), output: { path: output, filename: "app.js" },
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
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/*", r => r.request().url().startsWith(url) ? r.continue() : r.abort());
    for (let tab = 0; tab < 2; tab++) {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", e => errors.push(e.message));
      await page.goto(url); await page.getByText("synthetic-completed", { exact: false }).waitFor();
      const before = await page.locator("body").innerText();
      assert.match(before, /Требуется действие сотрудника/); assert.match(before, /Результат сохранения пока не подтверждён/);
      assert.match(before, /Ожидает повторения/); assert.match(before, /Автоматический повтор не запущен/);
      assert.equal(before.includes("Выполняется"), false, "expired lease must not look active");
      assert.equal(before.includes("%"), false, "no invented percentages");
      await page.reload(); await page.getByText("synthetic-completed", { exact: false }).waitFor();
      assert.equal(await page.locator("body").innerText(), before);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      if (process.argv[3] && tab === 0) { await mkdir(resolve(process.argv[3]), { recursive: true }); await page.screenshot({ path: resolve(process.argv[3], `status-${width}.png`), fullPage: true }); }
    }
    console.log(`PASS ${width}px: expiry, uncertain/completed distinction, reload, two tabs, no fake progress/overflow`);
    await context.close();
  }
} finally {
  await browser?.close(); if (server) await new Promise(done => server.close(done)); await rm(output, { recursive: true, force: true });
}
