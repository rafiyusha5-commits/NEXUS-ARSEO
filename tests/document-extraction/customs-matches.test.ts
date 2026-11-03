import assert from "node:assert/strict";
import { test } from "node:test";
import { matchSnapshot,mappedEvidence,type MatchSource,type CustomsMatch } from "../../src/lib/document-extraction/customs-matches.ts";
import {compareCommodities,type CommodityLine} from "../../src/lib/document-extraction/commodity-evidence.ts";
import {comparePackingItems} from "../../src/lib/document-extraction/packing-evidence.ts";
const line:CommodityLine={number:1,sku:null,description:"Synthetic cream",quantity:99,unit:"piece",amount:100,hsCode:"1806901900",grossKg:11,netKg:9,customsValue:200,warnings:["Артикул или количество из приложения не определены однозначно."]};
function fixture(){
 const base={document_version_id:"v1",shipment_transport_id:"vehicle",status:"confirmed",reviewed_at:"2026-01-01"};
 const sources:MatchSource[]=[{...base,id:"dt",status:"needs_review",extracted_data:{customs_record:{kind:"declaration",items:[line]}}},{...base,id:"invoice",extracted_data:{commodity_invoice:{number:"SYN-1",currency:"EUR",total:100,warnings:[],items:[{...line,warnings:[]}]}}},{...base,id:"packing",extracted_data:{supplier_lots:{kind:"packing",warnings:[],items:[{lot:"L1",description:"Synthetic cream",quantity:99}]}}}];
 const match:CustomsMatch={id:"m1",extraction_id:"dt",invoice_extraction_id:"invoice",packing_extraction_id:"packing",source_snapshot:structuredClone(matchSnapshot(sources)),lines:[{line:1,invoice_line:1,packing_line:1,product_id:"p1",sku:"SKU-1"}],reason:"Explicit matching",created_by:"user",created_at:"2026-01-01"};
 const products=[{id:"p1",sku:"SKU-1"}];return {sources,match,products};
}
test("explicit links project comparison only; original evidence remains unchanged",()=>{
 const f=fixture(),before=JSON.stringify(f),m=mappedEvidence(f.match,f.sources,f.products)!;
 assert.ok(m);assert.equal(m.items[0].sku,"SKU-1");assert.deepEqual(m.items[0].warnings,[]);assert.equal(JSON.stringify(f),before);
 const c=compareCommodities(m.items,"EUR",[m.invoice],[{sku:"SKU-1",unit:"piece",ordered:100,confirmed:null,shipped:null,hsCode:"1806901900"}]);
 assert.equal(c[0].invoiceMatched,true);assert.equal(c[0].orderedDelta,-1);assert.equal(comparePackingItems(m.items,[m.packing]).matched,true);
});
test("missing quantity or other warnings do not disappear through mapping",()=>{
 for(const change of [{quantity:null},{warnings:["Weight requires review"]}]){
  const f=fixture();Object.assign((f.sources[0].extracted_data.customs_record as {items:CommodityLine[]}).items[0]=structuredClone(line),change);f.match.source_snapshot=matchSnapshot(f.sources);
  const m=mappedEvidence(f.match,f.sources,f.products)!;assert.ok(m);assert.ok(m.items[0].warnings.length);
 }
});
test("changed OCR, version, transport, reviewer status or SKU invalidates mapping",()=>{
 const changes:Array<(f:ReturnType<typeof fixture>)=>void>=[f=>f.sources[0].document_version_id="v2",f=>f.sources[1].status="pending",f=>f.sources[2].shipment_transport_id="other",f=>f.products[0].sku="OTHER",f=>{f.sources[1].extracted_data.extra="new reading";},f=>f.sources[2].reviewed_at=null];
 for(const change of changes){const f=fixture();change(f);assert.equal(mappedEvidence(f.match,f.sources,f.products),null);}
});
test("omissions, duplicate rows and a contradictory original SKU refuse projection",()=>{
 const f=fixture();assert.equal(mappedEvidence({...f.match,lines:[]},f.sources,f.products),null);
 assert.equal(mappedEvidence({...f.match,lines:[f.match.lines[0],f.match.lines[0]]},f.sources,f.products),null);
 const g=fixture();(g.sources[0].extracted_data.customs_record as {items:CommodityLine[]}).items=[{...line,sku:"ORIGINAL"}];g.match.source_snapshot=matchSnapshot(g.sources);
 assert.equal(mappedEvidence(g.match,g.sources,g.products),null);
});
test("quantities may differ: explicit matching must not turn a mismatch green",()=>{
 const f=fixture();(f.sources[2].extracted_data.supplier_lots as {items:Array<{quantity:number}>}).items[0].quantity=98;f.match.source_snapshot=matchSnapshot(f.sources);
 const m=mappedEvidence(f.match,f.sources,f.products)!;assert.equal(comparePackingItems(m.items,[m.packing]).matched,false);
});
