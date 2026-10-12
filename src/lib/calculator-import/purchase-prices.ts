export const PRICE_ACTIONS = ["update","unchanged","missing_price","invalid_price","new_product","archived","unit_mismatch","manual_conflict","invalid_currency"] as const;
export type PurchasePriceReport = {
 applied: boolean; summary: { update: number; unchanged: number; skipped: number };
 items: { sku: string; action: typeof PRICE_ACTIONS[number]; price: number|null; old_price: number|null; source_row: number; currency?:string|null }[];
 snapshot?: string; currency?: string;
};
export function parsePurchasePriceReport(raw: unknown): PurchasePriceReport|null {
 if(!raw || typeof raw!=="object") return null;
 const r=raw as Record<string,unknown>;const s=r.summary as Record<string,unknown>;
 if(!s || ![s.update,s.unchanged,s.skipped].every(v=>Number.isSafeInteger(v)&&Number(v)>=0)||!Array.isArray(r.items)||typeof r.applied!=="boolean") return null;
 const items:PurchasePriceReport["items"]=[];
 for(const item of r.items){
  if(!item||typeof item!=="object"||typeof item.sku!=="string"||!PRICE_ACTIONS.includes(item.action)||!Number.isSafeInteger(item.source_row)) return null;
  const numeric=(v:unknown)=>v===null||typeof v==="number"&&Number.isFinite(v)&&v>=0;
  if(!numeric(item.price)||!numeric(item.old_price))return null;
  items.push({sku:item.sku,action:item.action,price:item.price,old_price:item.old_price,source_row:item.source_row,...(item.currency===null||typeof item.currency==="string"&&/^[A-Z]{3}$/.test(item.currency)?{currency:item.currency}:{})});
 }
 return {applied:r.applied,summary:{update:Number(s.update),unchanged:Number(s.unchanged),skipped:Number(s.skipped)},items,
 ...(typeof r.snapshot==="string"&&/^[a-f0-9]{64}$/.test(r.snapshot)?{snapshot:r.snapshot}:{}),...(typeof r.currency==="string"&&/^[A-Z]{3}$/.test(r.currency)?{currency:r.currency}:{})};
}