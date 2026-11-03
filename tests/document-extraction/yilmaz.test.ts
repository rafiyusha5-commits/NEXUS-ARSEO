import {test} from "node:test";
import assert from "node:assert/strict";
import {yilmazPage,parseYilmaz,parseYilmazCertificates,isSupplierLots,YILMAZ_MARKER} from "../../src/lib/document-extraction/yilmaz.ts";
import {extractShipmentFields,extractionNeedsReview,detectShipmentSourceKind} from "../../src/lib/document-extraction/rules.ts";
import type {PdfTextItem} from "../../src/lib/document-extraction/customs.ts";
const cell=(str:string,x:number,y:number):PdfTextItem=>({str,transform:[1,0,0,1,x,y],width:str.length*4});
const signature="YILMAZ FINDIK ENTEGRE LOT NO INVOICE NO: SYN2030000001";
function fixture(){return [cell(signature,30,650),cell("DATE : 12.01.2030",420,630),cell("123456789-01-11",40,580),cell("120 PCS",120,590),cell("8 CARTON TRAY",120,580),cell("ON 2 PALLETS",120,570),cell("MILKY CREAM HTS CODE: 200799000000",220,590),cell("120",410,590),cell("1,25.-€",460,590),cell("150,00.-€",520,590),cell("123456789-01-12",40,540),cell("60 PCS",120,550),cell("4 CARTON TRAY",120,540),cell("ON 1 PALLETS",120,530),cell("COCOA CREAM",220,550),cell("60",410,550),cell("2,00.-€",460,550),cell("120,00.-€",520,550),cell("180",410,540),cell("270,00.- €",520,540),cell("100,00 KG GROSS",250,480),cell("50,00 KG NET",250,465),cell("CONDITION EXW Samsun",40,420),cell("PAYMENT 50%",40,405)];}
const read=(items=fixture())=>parseYilmaz(signature+YILMAZ_MARKER+JSON.stringify([yilmazPage(items)]))!;
test("Yilmaz geometry survives shuffled PDF streams and separates final amount from last row",()=>{
 const a=read(),b=read(fixture().reverse());assert.deepEqual(a,b);assert.equal(a.invoice?.total,270);assert.deepEqual(a.invoice?.items.map(r=>[r.quantity,r.amount,r.sku]),[[120,150,null],[60,120,null]]);assert.equal(a.fields.pallet_count,3);assert.equal(a.fields.incoterms,"EXW Samsun");assert.deepEqual(a.lots.warnings,[]);assert.ok(a.lots.items.every(r=>r.expiry===null));
});
test("missing price, quantity, amount and duplicate lot do not pass completeness",()=>{
 for(const text of ["1,25.-€","120 PCS","150,00.-€","123456789-01-11"]){const r=read(fixture().filter(i=>i.str!==text));assert.ok(r.lots.warnings.length,text);}
 const items=fixture();items.push(cell("123456789-01-11",40,560));assert.ok(read(items).lots.warnings.length);
});
test("totals and units must agree with row prices and carton counts",()=>{
 for(const [from,to] of [["270,00.- €","271,00.- €"],["180","181"],["8 CARTON TRAY","7 CARTON TRAY"],["120 PCS","120 KG"],["1,25.-€","1.25.-€"]])assert.ok(read(fixture().map(i=>i.str===from?{...i,str:to}:i)).lots.warnings.length,from);
});
test("foreign invoices, malformed layout and multiple pages are not guessed",()=>{
 assert.equal(parseYilmaz("Fazer INVOICE NO 123"+YILMAZ_MARKER+"[]"),null);
 for(const body of ["null","{}","[null]","[]",JSON.stringify([yilmazPage(fixture()),yilmazPage(fixture())])])assert.equal(parseYilmaz(signature+YILMAZ_MARKER+body),null);
});
const certificate=(lot="123456789-01-11",date="02.03.2031")=>`YFE FR.135 HAZELNUT CREAM CERTIFICATE OF ANALYSIS\nBEST BEFORE DATE: ${date}\nLOT NO: ${lot}\nDESCRIPTION: MILK CREAM (ÜRÜN TANIMI)`;
test("certificate dates stay bound to their page and lot",()=>{
 const parsed=parseYilmazCertificates(certificate()+"\f"+certificate("123456789-01-12","03.03.2031"))!;
 assert.deepEqual(parsed.items.map(r=>[r.lot,r.expiry]),[["123456789-01-11","2031-03-02"],["123456789-01-12","2031-03-03"]]);assert.deepEqual(parsed.warnings,[]);assert.ok(isSupplierLots(parsed));
});
test("invalid, missing, conflicting and duplicated certificate dates require review",()=>{
 for(const s of [certificate(undefined,"31.02.2031"),certificate().replace("02.03.2031",""),certificate()+" BEST BEFORE DATE: 04.03.2031",certificate()+"\f"+certificate()]){const r=parseYilmazCertificates(s)!;assert.ok(r.warnings.length);assert.equal(extractionNeedsReview({supplier_lots:r}),true);}
 assert.equal(parseYilmazCertificates("LOT NO: 123456789-01-11 BEST BEFORE DATE: 02.03.2031"),null);
});
test("untrusted stored evidence validates every field before rendering",()=>{
 const r=parseYilmazCertificates(certificate())!;assert.equal(isSupplierLots({...r,items:[{...r.items[0],quantity:"10"}]}),false);assert.equal(isSupplierLots({...r,items:[{...r.items[0],expiry:"2031-02-31"}]}),false);
});
test("pipeline adds evidence without inventing SKU, receipt or manufacture date",()=>{
 const result=extractShipmentFields(signature+YILMAZ_MARKER+JSON.stringify([yilmazPage(fixture())]));assert.ok(result.data.supplier_lots);assert.equal(result.data.invoice_number,"SYN2030000001");assert.equal(result.data.manufacture_date,undefined);assert.equal(result.data.received_quantity,undefined);assert.deepEqual(result.conflicts,[]);
});
test("packing weight totals validate all lots without pretending lots are SKUs",()=>{
 assert.equal(detectShipmentSourceKind(signature+" PACKING LIST"),"specification");
 const points=[cell("YILMAZ FINDIK ENTEGRE PACKING LIST PARTY & MARK INVOICE NO: SYN2030000001",30,650),cell("123456789-01-11",40,580),cell("120 PCS ON",120,590),cell("8 CARTON TRAY",120,580),cell("2 PALLETS",120,570),cell("180GR MILKY CREAM",285,590),cell("50,00 KG",465,590),cell("21,60 KG",525,590),cell("50,00 KG",465,550),cell("21,60 KG",525,550)];
 const p=yilmazPage(points);const result=parseYilmaz(signature+YILMAZ_MARKER+JSON.stringify([p]))!;
 assert.equal(result.invoice,null);assert.equal(result.lots.kind,"packing");assert.equal(result.fields.gross_weight_kg,50);assert.equal(result.lots.items[0].netKg,21.6);assert.deepEqual(result.lots.warnings,[]);
 const bad=yilmazPage(points.map(i=>i.transform[5]===550&&i.str==="50,00 KG"?{...i,str:"51,00 KG"}:i));assert.ok(parseYilmaz(signature+YILMAZ_MARKER+JSON.stringify([bad]))!.lots.warnings.length);
});
