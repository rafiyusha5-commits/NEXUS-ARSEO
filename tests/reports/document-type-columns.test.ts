import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// PostgREST rejects an embed that names a missing column, and the report used to ignore that error,
// so its document list stayed empty. Every document_types(...) embed in src must name real columns.
const migration = readFileSync(new URL("../../supabase/migrations/202609271001_document_management.sql", import.meta.url), "utf8");
const block = migration.slice(migration.indexOf("create table if not exists public.document_types ("));
const columns = new Set([...block.slice(0, block.indexOf("\n);")).matchAll(/^\s{2}([a-z_]+)\s/gm)].map((match) => match[1]));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("document type embeds", () => {
  it("knows the real document_types columns", () => {
    assert.ok(columns.has("name_ru") && columns.has("code"));
    assert.ok(!columns.has("name"));
  });

  it("select only existing document_types columns everywhere in src", () => {
    const root = new URL("../../src", import.meta.url).pathname;
    const problems: string[] = [];
    for (const file of sources(root)) {
      for (const match of readFileSync(file, "utf8").matchAll(/document_types\(([^)]*)\)/g)) {
        for (const column of match[1].split(",").map((item) => item.trim()).filter(Boolean)) {
          if (!columns.has(column)) problems.push(`${file.slice(root.length)}: ${column}`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });
});
