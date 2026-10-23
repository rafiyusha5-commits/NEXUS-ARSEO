import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
it("fulfillment server action uses employee authentication and exactly one RPC", () => {
  const r = spawnSync(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(new URL("./fulfillment.check.mjs", import.meta.url))], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /fulfillment action passed/);
});
