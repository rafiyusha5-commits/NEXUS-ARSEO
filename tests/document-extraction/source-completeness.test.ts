import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import ts from "typescript";

const requireNative=createRequire(import.meta.url);
const source=readFileSync(new URL("../../src/lib/document-extraction/shipment-service.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const service={exports:{} as {extractShipmentSources:(db:unknown,id:string)=>Promise<{failed:number}>}};
new Function("require","module","exports",compiled)((id:string)=>{
  if(id==="server-only")return {};
  if(id==="@/lib/ocr/config")return {loadOcrConfig:()=>({limits:{runBudgetMs:1000}})};
  if(id==="@/lib/ocr/providers")return {createOcrProvider:()=>null};
  if(id==="./rules")return {conflictsAcrossDocuments:()=>[]};
  if(id==="./comparison-scope")return requireNative("../../src/lib/document-extraction/comparison-scope.ts");
  if(id.startsWith("@/")||id==="./text")return {};
  return requireNative(id);
},service,service.exports);
type Result={data:unknown[]|null;count:number|null;error:unknown};
const valid:Record<string,Result>={
  shipment_transports:{data:[],count:0,error:null},
  document_links:{data:[{document_id:"d1"}],count:1,error:null},
  documents:{data:[{id:"d1",archived_at:null,status:"approved",current_version:2,versions:[{id:"v1",version_number:1,is_current:true}]}],count:1,error:null},
  document_generations:{data:[],count:0,error:null},
  shipment_source_extractions:{data:[],count:0,error:null},
};
function client(replace:Record<string,Result>={}) {
  let downloaded=false, written=false;
  const db={
    from:(table:string)=>{
      const result=replace[table]??valid[table];
      const query={
        select:(_fields:string,options:{count?:string})=>{assert.equal(options.count,"exact");return query;},
        eq:()=>query,neq:()=>query,is:()=>query,or:()=>query,in:()=>query,
        then:(resolve:(value:Result)=>unknown)=>Promise.resolve(result).then(resolve),
      };
      return query;
    },
    rpc:()=>{written=true;throw Error("Unexpected write");},
    storage:{from:()=>({download:()=>{downloaded=true;throw Error("Unexpected download");}})},
  };
  return {db,untouched:()=>!downloaded&&!written};
}
test("extraction fails closed for failed, missing-count and truncated source lists",async()=>{
  for(const table of Object.keys(valid))for(const result of [
    {...valid[table],error:{message:"Unavailable"}},
    {...valid[table],count:null},
    {...valid[table],count:1001},
  ]){
    const c=client({[table]:result});
    await assert.rejects(service.exports.extractShipmentSources(c.db,"s1"),/полный список/);
    assert.equal(c.untouched(),true,table);
  }
});
test("a missing document, rejected document or mismatched current version is never downloaded",async()=>{
  for(const documents of [
    {data:[],count:0,error:null},
    {data:[{id:"d1",status:"rejected"}],count:1,error:null},
  ]){
    const c=client({documents});
    await assert.rejects(service.exports.extractShipmentSources(c.db,"s1"));
    assert.ok(c.untouched());
  }
  const c=client();
  assert.equal((await service.exports.extractShipmentSources(c.db,"s1")).failed,1);
  assert.ok(c.untouched());
});
