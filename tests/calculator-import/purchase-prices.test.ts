import assert from "node:assert/strict";
import {it} from "node:test";
import {parsePurchasePriceReport} from "../../src/lib/calculator-import/purchase-prices.ts";
import {parseReport} from "../../src/lib/reference-import/report.ts";
const report={applied:false,summary:{update:1,unchanged:0,skipped:1},items:[{sku:"403747",action:"update",price:0.99,old_price:null,source_row:6},{sku:"178",action:"missing_price",price:null,old_price:null,source_row:7}],snapshot:"a".repeat(64),currency:"EUR"};
it("price preview keeps missing prices distinct from zero and preserves currency and review hash",()=>{
 const parsed=parsePurchasePriceReport(report);assert.ok(parsed);assert.equal(parsed.items[1].price,null);assert.equal(parsed.currency,"EUR");assert.equal(parsed.snapshot,"a".repeat(64));
 assert.equal(parsePurchasePriceReport({...report,items:[{...report.items[0],price:0}]})?.items[0].price,0);
});
it("invalid price reports never reach the confirmation interface",()=>{
 assert.equal(parsePurchasePriceReport({...report,items:[{...report.items[0],price:"0.99"}]}),null);
 assert.equal(parsePurchasePriceReport({...report,items:[{...report.items[0],price:-1}]}),null);
 assert.equal(parsePurchasePriceReport({...report,summary:{update:1,unchanged:0,skipped:NaN}}),null);
});
it("future calculator imports expose their separate price result instead of silently dropping it",()=>{
 const parsed=parseReport({summary:{create:0,update:0,unchanged:1,conflict:0,error:0},items:[],purchase_prices:report});assert.ok(parsed?.purchasePrices);assert.equal(parsed.purchasePrices.summary.skipped,1);
});