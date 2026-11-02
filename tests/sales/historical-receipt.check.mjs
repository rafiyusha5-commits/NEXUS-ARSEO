import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
registerHooks({resolve(s,c,next){
 if(s==='@/app/sales/actions')return{url:'data:text/javascript,export async function recordHistoricalSaleReceipt(){}',shortCircuit:true};
 return next(s,c);
},load(u,c,next){
 if(u.endsWith('.tsx'))return{format:'module',source:ts.transpileModule(readFileSync(new URL(u),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022}}).outputText,shortCircuit:true};
 return next(u,c);
}});
const {HistoricalActualReceipt}=await import('../../src/components/sales/historical-actual-receipt.tsx');
const snapshot={items:[{sku:'TEST',uom:'piece',required_pct:80,reservations:[{batch:'LOT',expiry:'2027-01-01',sale_quantity:10,actual_pct:74.07}]}]};
const props={saleId:'test',status:'reserved',canRecord:true,preview:{token:'a'.repeat(32),valid:false,snapshot},error:false,receipts:[]};
const render=p=>renderToStaticMarkup(React.createElement(HistoricalActualReceipt,{...props,...p}));
assert.match(render({}),/name="acknowledged"/);assert.match(render({}),/name="expected_token"/);
assert.match(render({}),/74\.07% \/ 80%/);assert.match(render({}),/10 шт\./);
for(const p of [{canRecord:false},{status:'shipped'},{error:true},{preview:{...props.preview,valid:true}}])assert.doesNotMatch(render(p),/name="acknowledged"/);
const done=render({status:'shipped',preview:{...props.preview,valid:true},receipts:[{id:'receipt',created_at:'2026-11-02T00:00:00Z',created_by:'employee',reason:'Подтверждено владельцем без письма',snapshot}]});
assert.match(done,/Подтверждено владельцем без письма/);assert.match(done,/74\.07% \/ 80%/);assert.match(done,/employee/);
assert.match(done,/предварительного согласования не было/);
console.log('historical receipt UI passed');
