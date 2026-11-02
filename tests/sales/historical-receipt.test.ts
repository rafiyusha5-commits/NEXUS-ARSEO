import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
it("historical receipt UI separates actual receipt, requirement and preserved deviations", () => {
  const r = spawnSync(process.execPath, [fileURLToPath(new URL("./historical-receipt.check.mjs", import.meta.url))], { encoding: "utf8", timeout: 15000 });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});
