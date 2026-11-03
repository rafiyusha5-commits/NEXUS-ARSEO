import assert from "node:assert/strict";
import { test } from "node:test";
import { customsTotals, mappedCustomsSummary } from "../../src/lib/document-extraction/customs-totals.ts";
import type { CommodityLine } from "../../src/lib/document-extraction/commodity-evidence.ts";

const line: CommodityLine = {number:1,sku:"SYN-1",description:"Synthetic product",quantity:10,unit:"piece",amount:100,customsValue:200,hsCode:null,grossKg:11,netKg:10,warnings:[]};
const fields = [{label:"Сумма по счёту (гр. 22)",value:"100,00"},{label:"Общая таможенная стоимость (гр. 12)",value:"200,00"}];
const oldWarnings = ["Есть строки, требующие проверки по оригиналу.","Сумма цен товарных строк / графа 22: итог не подтверждён","Сумма таможенных стоимостей / графа 12: итог не подтверждён"];

test("mapped totals resolve a missing-SKU warning only after checking both header sums, without rewriting evidence",()=>{
  const before=JSON.stringify({line,fields,oldWarnings});
  const result=mappedCustomsSummary(fields,[line],1,oldWarnings);
  assert.deepEqual(result.warnings,[]);
  assert.equal(result.fields.at(-2)?.value,"100,00 · совпадает");
  assert.equal(result.fields.at(-1)?.value,"200,00 · совпадает");
  assert.equal(JSON.stringify({line,fields,oldWarnings}),before);
  assert.ok(customsTotals([{...line,sku:null,warnings:["Missing SKU"]}],1,oldWarnings,[100,200]).every(t=>!t.matched));
});

test("mapping cannot hide changed, missing or duplicate header totals",()=>{
  for(const wrong of [[{...fields[0],value:"101,00"},fields[1]],[fields[1]],[...fields,fields[0]],[{...fields[0],value:"not an amount"},fields[1]]]) {
    const result=mappedCustomsSummary(wrong,[line],1,oldWarnings);
    assert.deepEqual(result.warnings,[oldWarnings[1]]);
  }
  assert.match(mappedCustomsSummary([{...fields[0],value:"101,00"},fields[1]],[line],1,oldWarnings).fields.at(-2)!.value,/РАСХОЖДЕНИЕ/);
});

test("mapped totals stay unconfirmed for missing rows, amounts, original warnings or duplicate rows",()=>{
  const cases: Array<{items:CommodityLine[];expected:number;warnings:string[]}>=[
    {items:[line],expected:2,warnings:oldWarnings},
    {items:[{...line,amount:null,customsValue:null}],expected:1,warnings:oldWarnings},
    {items:[{...line,warnings:["Unread quantity"]}],expected:1,warnings:oldWarnings},
    {items:[line],expected:1,warnings:[...oldWarnings,"Unexpected page"]},
    {items:[line,line],expected:2,warnings:oldWarnings},
  ];
  for(const c of cases){
    const result=mappedCustomsSummary(fields,c.items,c.expected,c.warnings);
    assert.ok(result.warnings.includes(oldWarnings[1]));assert.ok(result.warnings.includes(oldWarnings[2]));
    if(c.warnings.includes("Unexpected page"))assert.ok(result.warnings.includes("Unexpected page"));
  }
});
