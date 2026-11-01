import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { it } from "node:test";

it("ExcelJS minimatch 3.1.5/5.1.9 has no globparts amplification preprocessor on all production paths", () => {
  const chains = [
    ["exceljs", "archiver", "archiver-utils", "glob"],
    ["exceljs", "archiver", "readdir-glob"],
    ["exceljs", "archiver", "zip-stream", "archiver-utils", "glob"],
    ["exceljs", "unzipper", "fstream", "rimraf", "glob"],
  ];
  for (const chain of chains) {
    let req = createRequire(import.meta.url);
    for (const name of chain) req = createRequire(req.resolve(`${name}/package.json`));
    assert.equal(JSON.parse(readFileSync(req.resolve("minimatch/package.json"), "utf8")).version, chain.includes("readdir-glob") ? "5.1.9" : "3.1.5");
    const file = req.resolve("minimatch");
    assert.doesNotMatch(readFileSync(file, "utf8"), /firstPhasePreProcess|secondPhasePreProcess|optimizationLevel/);
    const result = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", `
      const assert = require('node:assert/strict');
      const {Minimatch} = require(process.argv[1]);
      for (const n of [8, 32, 128]) {
        const m = new Minimatch(Array(n).fill('**/..').join('/') + '/x', {optimizationLevel: 2, nobrace: true});
        assert.equal(m.globParts.length, 1);
        assert.equal(m.globParts[0].length, n * 2 + 1);
      }
    `, file], {encoding: "utf8", timeout: 5000, windowsHide: true});
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  }
});
