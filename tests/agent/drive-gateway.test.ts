import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
it("drive gateway uses employee JWT and confines its server credential", () => {
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", new URL("./server-condition.mjs", import.meta.url).href,
    "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", fileURLToPath(new URL("./drive-gateway.check.ts", import.meta.url))], { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  assert.match(result.stdout, /Drive gateway checks passed/);
});
