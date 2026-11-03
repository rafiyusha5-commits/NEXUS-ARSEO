import { customsLayout, type PdfTextItem } from "./customs.ts";
import type { CommodityInvoice } from "./commodity-evidence.ts";

export const YILMAZ_MARKER = "\n--- YILMAZ LOT TABLE ---\n";
const flat = (s: string) => s.replace(/\|/gu, " ").replace(/\s+/gu, " ").trim();
export const isYilmazTable = (s: string) => /YILMAZ\s+FINDIK\s+ENTEGRE/iu.test(flat(s)) && /LOT\s+NO|PARTY\s*&\s*MARK/iu.test(flat(s)) && /INVOICE\s+NO/iu.test(flat(s));
export type SupplierLot = { lot: string; description: string; quantity: number | null; cartons: number | null; pallets: number | null; grossKg: number | null; netKg: number | null; expiry: string | null };
export type SupplierLots = { kind: "invoice" | "packing" | "certificate"; items: SupplierLot[]; warnings: string[] };
type Page = { packing: boolean; header: string; footer: string; total: string; pieces: string; rows: { lot: string; quantity: string; description: string; unit: string; price: string; amount: string }[] };

// The supplier's PDF stores columns in unrelated text-stream order. Anchor rows
// to printed lot numbers and keep columns separate. No product SKU is inferred.
export function yilmazPage(items: PdfTextItem[]) {
  const text = flat(customsLayout(items));
  if (!isYilmazTable(text)) return null;
  const packing = /PACKING\s+LIST/iu.test(text);
  const lots = items.filter(i => /^\d{6,14}-\d{2,4}-\d{2,4}$/u.test(i.str.trim()) && i.transform[4] < 110).sort((a,b) => b.transform[5]-a.transform[5]);
  if (!lots.length || lots.length > 100) return null;
  const top = lots[0].transform[5] + 18;
  const last = lots.at(-1)!.transform[5];
  const slice = (rows: PdfTextItem[], left: number, right: number) => flat(customsLayout(rows.filter(i=>i.transform[4]>=left && i.transform[4]<right)));
  const page: Page = { packing, header: flat(customsLayout(items.filter(i=>i.transform[5]>top))), footer: flat(customsLayout(items.filter(i=>i.transform[5]<last-20))),
    total: slice(items.filter(i=>i.transform[5]<last+4 && i.transform[5]>last-6),499,600),
    pieces: slice(items.filter(i=>i.transform[5]<last+4 && i.transform[5]>last-6),402,445), rows: [] };
  for (let n=0;n<lots.length;n++) {
    const y=lots[n].transform[5];
    const upper=n ? (lots[n-1].transform[5]+y)/2 : top;
    const lower=n+1<lots.length ? (lots[n+1].transform[5]+y)/2 : last-20;
    const row=items.filter(i=>i.transform[5]<=upper && i.transform[5]>lower);
    const money=row.filter(i=>i.transform[5]>=y+4);
    page.rows.push({lot:lots[n].str.trim(),quantity:slice(row,110,packing?210:215),description:slice(row,packing?280:215,packing?450:402),
      unit:slice(money,packing?450:402,packing?516:445),price:packing?"":slice(money,445,499),amount:slice(money,packing?516:499,600)});
  }
  return page;
}
const decimal = (s: string | undefined) => {
  if (!s || !/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/u.test(s)) return null;
  const n=Number(s.replace(/\./gu,"").replace(",",".")); return Number.isFinite(n)?n:null;
};
const integer = (s:string|undefined) => {const n=decimal(s);return n!==null && Number.isSafeInteger(n) && n>0?n:null;};
const money = (s: string) => decimal(s.match(/^([\d.,]+)\s*\.-\s*€$/u)?.[1]);
const iso = (s:string|undefined) => {const m=s?.match(/^(\d{2})\.(\d{2})\.(\d{4})$/u);if(!m)return null;const d=`${m[3]}-${m[2]}-${m[1]}`;const t=new Date(d+"T00:00:00Z");return Number.isFinite(t.getTime())&&t.toISOString().slice(0,10)===d?d:null;};

export function parseYilmaz(raw: string) {
  if (!isYilmazTable(raw)) return null;
  const encoded=raw.split(YILMAZ_MARKER);
  if(encoded.length!==2)return null;
  let page:Page;
  try {const pages=JSON.parse(encoded[1]);if(!Array.isArray(pages)||pages.length!==1)return null;page=pages[0];}catch{return null;}
  if(!page || typeof page.packing!=="boolean" || ![page.header,page.footer,page.total,page.pieces].every(s=>typeof s==="string") || !Array.isArray(page.rows) || page.rows.length>100 || !page.rows.every(r=>r&&[r.lot,r.quantity,r.description,r.unit,r.price,r.amount].every(s=>typeof s==="string")))return null;
  const fields:Record<string,string|number>={};
  const warnings:string[]=[];
  const number=page.header.match(/INVOICE\s+NO\s*:\s*([A-Z0-9/-]+)/iu)?.[1]??null;
  if(number) fields.invoice_number=number;else warnings.push("Не прочитан номер инвойса.");
  const date=iso(page.header.match(/DATE(?:D)?\s*:\s*(\d{2}\.\d{2}\.\d{4})/iu)?.[1]);
  if(date) fields.invoice_date=date;
  const delivery=page.footer.match(/CONDITION\s+(EXW|FCA|DAP|CPT|CIP)\s+(.+?)(?=\s+PAYMENT\b)/iu);
  if(delivery)fields.incoterms=`${delivery[1]} ${delivery[2]}`;
  const total=money(page.total), pieces=integer(page.pieces);
  const lots:SupplierLots={kind:page.packing?"packing":"invoice",items:[],warnings};
  const invoice:CommodityInvoice={number,currency:"EUR",total,items:[],warnings};
  for(const [n,r] of page.rows.entries()) {
    const qty=integer(r.quantity.match(/^([\d.]+)\s+PCS\b/u)?.[1]);
    const cartons=integer(r.quantity.match(/\b([\d.]+)\s+CARTON\s+TRAY\b/u)?.[1]);
    const pallets=integer(r.quantity.match(/\b(\d+)\s+PALLETS\b/u)?.[1]);
    const lot:SupplierLot={lot:r.lot,description:r.description,quantity:qty,cartons,pallets,grossKg:page.packing?decimal(r.unit.match(/^([\d.,]+)\s+KG$/u)?.[1]):null,netKg:page.packing?decimal(r.amount.match(/^([\d.,]+)\s+KG$/u)?.[1]):null,expiry:null};
    const issues:string[]=[];
    if(!/^\d{6,14}-\d{2,4}-\d{2,4}$/u.test(r.lot)||page.rows.filter(x=>x.lot===r.lot).length!==1)issues.push("Номер партии повторяется или не прочитан.");
    if(qty===null||cartons===null||pallets===null||qty%cartons!==0)issues.push("Количество, короба или паллеты строки требуют проверки.");
    if(page.packing){if(lot.grossKg===null||lot.netKg===null||lot.grossKg<lot.netKg)issues.push("Не подтверждён вес строки.");}
    else {
      const unitPrice=money(r.price),amount=money(r.amount);
      if(integer(r.unit)!==qty||unitPrice===null||amount===null||qty===null||Math.abs(qty*unitPrice-amount)>0.011)issues.push("Количество × цена не подтверждает сумму строки.");
      invoice.items.push({number:n+1,sku:null,description:r.description,quantity:qty,unit:"piece",amount,hsCode:r.description.match(/HTS CODE:\s*(\d+)/u)?.[1]??null,grossKg:null,netKg:null,customsValue:null,warnings:issues});
    }
    warnings.push(...issues);lots.items.push(lot);
  }
  if(!page.rows.length)warnings.push("Товарные строки не прочитаны.");
  const sum=(key:"quantity"|"grossKg"|"netKg"|"pallets")=>lots.items.reduce((s,r)=>s+(r[key]??0),0);
  if(page.packing){
    const weights=page.footer.match(/^([\d.,]+)\s+KG\s+([\d.,]+)\s+KG\b/u);
    const gross=decimal(weights?.[1]),net=decimal(weights?.[2]);
    if(gross===null||net===null||Math.abs(sum("grossKg")-gross)>0.011||Math.abs(sum("netKg")-net)>0.011)warnings.push("Суммы весов не подтверждают полноту упаковочного листа.");
    else {fields.gross_weight_kg=gross;fields.net_weight_kg=net;}
  }else{
    if(pieces===null||pieces!==sum("quantity")||total===null||invoice.items.some(r=>r.amount===null)||Math.abs(invoice.items.reduce((s,r)=>s+(r.amount??0),0)-total)>0.011)warnings.push("Сумма строк не подтверждает итоги инвойса.");
    const gross=decimal(page.footer.match(/([\d.,]+)\s+KG\s+GROSS/u)?.[1]),net=decimal(page.footer.match(/([\d.,]+)\s+KG\s+NET/u)?.[1]);
    if(gross!==null)fields.gross_weight_kg=gross;if(net!==null)fields.net_weight_kg=net;
  }
  if(lots.items.length&&lots.items.every(r=>r.pallets!==null))fields.pallet_count=sum("pallets");
  return {fields,lots,invoice:page.packing?null:invoice};
}

export const isYilmazCertificate = (s:string) => /\bYFE\b/u.test(flat(s)) && /\bFR\.135\b/u.test(flat(s)) && /HAZELNUT\s+CREAM\s+CERTIFICATE\s+OF\s+.*?ANALYSIS/iu.test(flat(s)) && /BEST\s+BEFORE\s+DATE/iu.test(flat(s));
export function parseYilmazCertificates(raw:string):SupplierLots|null {
  if(!isYilmazCertificate(raw))return null;
  const result:SupplierLots={kind:"certificate",items:[],warnings:[]};
  for(const page of raw.split("\f")) {
    const t=flat(page);if(!t)continue;
    const lot=[...t.matchAll(/LOT NO:\s*([\d-]+)/gu)],dates=[...t.matchAll(/BEST BEFORE DATE:\s*(\d{2}\.\d{2}\.\d{4})/gu)];
    const expiry=dates.length===1?iso(dates[0][1]):null;
    if(!isYilmazCertificate(t)||lot.length!==1||!/^\d{6,14}-\d{2,4}-\d{2,4}$/u.test(lot[0][1])||!expiry){result.warnings.push("Сертификат: партия или срок не определены однозначно на странице.");continue;}
    const description=t.match(/DESCRIPTION:\s*(.+?)\s*\(ÜRÜN TANIMI\)/u)?.[1]?.replace(/\s*\(ALICI\)/gu,"")??"";
    if(result.items.some(r=>r.lot===lot[0][1])){result.warnings.push("Сертификаты повторяют партию; требуется проверка.");continue;}
    result.items.push({lot:lot[0][1],description,expiry,quantity:null,cartons:null,pallets:null,grossKg:null,netKg:null});
  }
  return result;
}
export function isSupplierLots(value:unknown):value is SupplierLots {
  if(!value||typeof value!=="object")return false;const p=value as SupplierLots;
  return ["invoice","packing","certificate"].includes(p.kind)&&Array.isArray(p.warnings)&&p.warnings.every(w=>typeof w==="string")&&Array.isArray(p.items)&&p.items.every(r=>r&&typeof r.lot==="string"&&typeof r.description==="string"&&(r.expiry===null||typeof r.expiry==="string"&&iso(r.expiry.split("-").reverse().join("."))===r.expiry)&&[r.quantity,r.cartons,r.pallets,r.grossKg,r.netKg].every(v=>v===null||typeof v==="number"&&Number.isFinite(v)&&v>=0));
}
