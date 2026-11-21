// Read-only check of every embedded select in the application (found 2026-11-21: two pages failed silently because
// a table is linked twice and PostgREST cannot choose the link). Takes each `.from("table").select("...(...)...")`
// literal from src and asks PostgREST with the public key and limit=0: an ambiguous (PGRST201) or unknown (PGRST200)
// relationship is reported before any permission check, so no data is read.
//
//   NEXT_PUBLIC_SUPABASE_URL=... NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=... node scripts/check-postgrest-embeds.mjs
//
// Fix a finding by naming the link: `table!constraint_name(columns)`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  process.exit(2);
}
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) files.push(full);
  }
})(path.join(root, "src"));
const pattern = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)\s*\.select\(\s*(["'`])([^"'`]*\([^"'`]*)\2/g;
const queries = new Map();
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  for (const match of text.matchAll(pattern)) {
    if (match[3].includes("${")) continue;
    const id = `${match[1]}|${match[3].replace(/\s+/g, "")}`;
    if (!queries.has(id)) queries.set(id, `${path.relative(root, file)}:${text.slice(0, match.index).split("\n").length}`);
  }
}
let problems = 0;
for (const [id, where] of queries) {
  const [table, select] = id.split("|");
  const response = await fetch(`${url}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=0`, { headers: { apikey: key } });
  const body = await response.json().catch(() => ({}));
  if (["PGRST200", "PGRST201", "PGRST100"].includes(body.code)) {
    problems++;
    console.log(`${body.code} ${where} ${table}: ${String(body.message ?? "").slice(0, 160)}`);
  }
}
console.log(`Запросов проверено: ${queries.size}, ошибок связей: ${problems}.`);
process.exit(problems ? 1 : 0);
