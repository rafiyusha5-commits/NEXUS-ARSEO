import { isCommodityInvoice, isCommodityLine, type CommodityInvoice, type CommodityLine } from "./commodity-evidence.ts";
import { isPackingEvidence, type PackingEvidence } from "./packing-evidence.ts";

export type MatchSource = { id: string; document_version_id: string; shipment_transport_id: string | null; extracted_data: Record<string, unknown>; confirmed_data?: Record<string,unknown>; status: string; reviewed_at: string | null };
export type MatchLine = { line: number; invoice_line: number; packing_line: number; product_id: string; sku: string };
export type CustomsMatch = { id: string; extraction_id: string; invoice_extraction_id: string; packing_extraction_id: string; source_snapshot: unknown; lines: MatchLine[]; reason: string; created_by: string; created_at: string };
export const matchSnapshot = (sources: MatchSource[]) => sources.map(s => ({ id: s.id, version: s.document_version_id, transport: s.shipment_transport_id, data: s.extracted_data, confirmed:Object.fromEntries(Object.entries(s.confirmed_data??{}).filter(([key])=>!["customs_record","customs_review_note","customs_mapping_id"].includes(key))) }));
const canonical = (value: unknown): string => JSON.stringify(value && typeof value === "object" ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([k,v])=>[k,JSON.parse(canonical(v))])) : value ?? null);
export function packingMatchRows(data: Record<string, unknown>): Array<{ description: string; quantity: number | null; unit: string; sku: string | null }> {
  const p=data.supplier_lots;
  if (p && typeof p==="object" && "kind" in p && p.kind==="packing" && "items" in p && Array.isArray(p.items)) {
    if (!p.items.every(r=>r && typeof r.description==="string" && typeof r.quantity==="number" && Number.isFinite(r.quantity) && r.quantity>=0)) return [];
    return p.items.map(r=>({description:`${r.lot ?? ""} · ${r.description}`,quantity:r.quantity,unit:"piece",sku:null}));
  }
  return isPackingEvidence(data.packing_evidence) ? data.packing_evidence.items.map(r=>({description:r.sku,quantity:r.quantity,unit:r.unit,sku:r.sku})) : [];
}
export function mappedEvidence(match: CustomsMatch | undefined, sources: MatchSource[], products: Array<{ id: string; sku: string }>) {
  if (!match || sources.length!==3 || sources[0].id!==match.extraction_id || sources[1].id!==match.invoice_extraction_id || sources[2].id!==match.packing_extraction_id
    || sources.some(s=>s.shipment_transport_id!==sources[0].shipment_transport_id)
    || sources.slice(1).some(s=>s.status!=="confirmed" || !s.reviewed_at) || canonical(match.source_snapshot)!==canonical(matchSnapshot(sources))) return null;
  const record=sources[0].extracted_data.customs_record;
  const invoice=sources[1].extracted_data.commodity_invoice;
  if (!record || typeof record!=="object" || !("items" in record) || !Array.isArray(record.items) || !record.items.every(isCommodityLine) || !isCommodityInvoice(invoice)) return null;
  const pack=packingMatchRows(sources[2].extracted_data), count=record.items.length;
  if (!count || match.lines.length!==count || invoice.items.length!==count || pack.length!==count
    || ["line","invoice_line","packing_line","product_id"].some(k=>new Set(match.lines.map(l=>l[k as keyof MatchLine])).size!==count)
    || match.lines.some(l=>![l.line,l.invoice_line,l.packing_line].every(n=>Number.isInteger(n)&&n>=1&&n<=count) || !products.some(p=>p.id===l.product_id&&p.sku===l.sku))) return null;
  const items:CommodityLine[]=[], invoiceItems:CommodityLine[]=[], packing: PackingEvidence["items"]=[];
  for(const m of [...match.lines].sort((a,b)=>a.line-b.line)) {
    const d=record.items[m.line-1], i=invoice.items[m.invoice_line-1], p=pack[m.packing_line-1];
    if (d.number!==m.line || i.number!==m.invoice_line || [d.sku,i.sku,p.sku].some(s=>s!==null&&s!==m.sku)) return null;
    // Resolve only the specific missing-SKU warning, and only when quantity/unit were read.
    const warnings = d.quantity!==null && d.unit && !d.sku ? d.warnings.filter(w=>w!=="Артикул или количество из приложения не определены однозначно.") : d.warnings;
    items.push({...d,sku:m.sku,warnings}); invoiceItems.push({...i,sku:m.sku});
    if(p.quantity===null)return null;
    packing.push({sku:m.sku,quantity:p.quantity,unit:p.unit});
  }
  const packingSource=sources[2].extracted_data.supplier_lots ?? sources[2].extracted_data.packing_evidence;
  const warnings=packingSource && typeof packingSource==="object" && "warnings" in packingSource && Array.isArray(packingSource.warnings) && packingSource.warnings.every(w=>typeof w==="string") ? packingSource.warnings as string[] : ["Предупреждения упаковочного листа не прочитаны"];
  return { items, invoice: {...invoice,items:invoiceItems} satisfies CommodityInvoice, packing: {number:null,items:packing,total:packing.reduce((sum,p)=>sum+p.quantity,0),warnings} satisfies PackingEvidence, match };
}
