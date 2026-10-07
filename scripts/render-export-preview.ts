// Dev aid for the export workbook visual checks:
//   node scripts/render-export-preview.ts <book.xlsx> <outDir> [sheet ...]
// Renders sheets to HTML and, when Chrome/Edge is installed, to PNG screenshots.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { XlsxWorkbook } from "../src/lib/export-workbook/xlsx-package.ts";
import { renderSheetHtml, sheetPixelSize } from "../src/lib/export-workbook/preview.ts";

const [file, outDir, ...requested] = process.argv.slice(2);
if (!file || !outDir) { console.error("Usage: node scripts/render-export-preview.ts <book.xlsx> <outDir> [sheet ...]"); process.exit(1); }
const browsers = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter((path): path is string => !!path && existsSync(path));

const workbook = XlsxWorkbook.load(new Uint8Array(readFileSync(file)));
mkdirSync(outDir, { recursive: true });
const sheets = requested.length ? requested : workbook.sheetNames().filter(name => workbook.sheetState(name) === "visible");
for (const [index, name] of sheets.entries()) {
  const base = `${String(index + 1).padStart(2, "0")}-${name.replace(/[^\p{L}\p{N}]+/gu, "_")}`;
  const htmlPath = resolve(join(outDir, `${base}.html`));
  writeFileSync(htmlPath, renderSheetHtml(workbook, name));
  const { width, height } = sheetPixelSize(workbook, name);
  if (browsers[0]) {
    const png = resolve(join(outDir, `${base}.png`));
    spawnSync(browsers[0], ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=${Math.min(width, 3000)},${Math.min(height, 6000)}`, `--screenshot=${png}`, pathToFileURL(htmlPath).href], { stdio: "ignore" });
  }
  console.log(`${name}: ${htmlPath}`);
}
