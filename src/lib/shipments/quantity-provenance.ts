export type QuantityEvent = {
  id: string; field: "confirmed" | "shipped"; previous: number | null; quantity: number;
  at: string; actor: string | null; documentId: string; document: string;
  version: number; currentVersion: boolean; reviewed: boolean; latest: boolean;
};
export type DemandEvent = {
  id: string; action: string; previous: number | null; quantity: number;
  uom: string; previousUom: string | null; at: string; actor: string | null;
};
export type ReceiptEvidence = {
  id: string; at: string; actor: string | null; performedBy: string;
  expected: number; accepted: number; damaged: number; shortage: number; overage: number; reason: string | null;
};
export type ProvenanceItem = {
  id: string; sku: string | null; name: { ru?: string; en?: string } | null; uom: string; transport: number | null;
  ordered: number; confirmed: number | null; shipped: number | null; received: number | null;
  history: QuantityEvent[]; demandHistory: DemandEvent[]; receipts: ReceiptEvidence[];
};
export type QuantityProvenance = { inventoryVisible: boolean; auditVisible: boolean; items: ProvenanceItem[] };

// Display deltas in the persisted item unit, never warehouse shortage or an inferred conversion.
export function quantityDifferences(item: ProvenanceItem) {
  const delta = (a: number | null, b: number | null) => a === null || b === null ? null : Math.round((a - b) * 1000) / 1000;
  return { supplierVsDemand: delta(item.confirmed, item.ordered), receiptVsShipped: delta(item.received, item.shipped) };
}
export function quantitySource(item: ProvenanceItem, field: "confirmed" | "shipped") {
  const latest = item.history.filter(event => event.field === field).at(-1);
  return latest?.latest && latest.quantity === item[field] ? latest : null;
}
