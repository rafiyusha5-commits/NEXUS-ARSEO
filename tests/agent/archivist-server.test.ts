import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {it} from "node:test";
it("archivist reads only safe columns with employee grants and uses protected price RPCs",()=>{
 const result=spawnSync(process.execPath,["--conditions=react-server","--import",new URL("./server-condition.mjs",import.meta.url).href,"--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",fileURLToPath(new URL("./archivist-server.check.ts",import.meta.url))],{encoding:"utf8",timeout:15000});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.match(result.stdout,/Archivist server checks passed/);
});
