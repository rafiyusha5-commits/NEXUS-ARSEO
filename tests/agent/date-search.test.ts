import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("date search uses ready/arrival and loading filters, deduplicates shipments and keeps text predicates", () => {
  // Server-only modules are exercised in React's server condition, without weakening their guard.
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", new URL("./server-condition.mjs", import.meta.url).href, "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(new URL("./date-search-server.check.ts", import.meta.url))], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Date search server checks passed/);
});
