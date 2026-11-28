// Batches of a shipment expected by the packing list (202611280700): what shipment_expected_batches returns, the batches
// of the recognized supplier documents to add, the first rows of a receiving form. Rendering and suggestions only: the
// database binds a label at the receipt and refuses anything else.
import { isSupplierLots, type SupplierLot } from "../document-extraction/yilmaz.ts";
import type { ExpectedState } from "../scan/lookup.ts";

export type ExpectedBatch = {
  id: string; batch: string; expiry_date: string | null; manufacture_date: string | null; quantity: string | null; packages: number | null;
  source: "manual" | "packing_list"; source_note: string | null; state: ExpectedState; note: string | null; batch_id: string | null;
  label_code: string | null; printed: boolean; other_expiries: string[];
};
export type ExpectedItem = {
  item_id: string; product_id: string; sku: string; product: string; uom: string; quantity: string; transport_id: string | null;
  transport_no: number | null; transport_status: string | null; received: boolean; batches: ExpectedBatch[];
};
export type ShipmentExpected = {
  shipment_id: string; shipment_number: string; status: string; can_manage: boolean; items: ExpectedItem[];
  orphans: Array<{ id: string; batch: string; sku: string; label_code: string | null }>;
};

export const expectedStateLabel: Record<ExpectedState, string> = {
  expected: "ожидается", received: "принята, наклейка привязана", mismatch: "не совпала с листом", not_received: "не принята",
  missing: "не пришла", removed: "позиция удалена", cancelled: "отменена",
};
export const unitLabel: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "авто" };

/** The batch numbers of the supplier's packing list, invoice and certificates (the same lot merged: quantity from the
 *  packing list, expiry from a certificate), without those already added to the shipment. */
export type PackingLot = { lot: string; description: string; quantity: number | null; expiry: string | null; packages: number | null; documents: string[] };
export type SourceRow = { status: string; extracted_data: Record<string, unknown> | null; document: { title?: string | null } | null };
export function packingLots(rows: SourceRow[], added: string[]): PackingLot[] {
  const skip = new Set(added.map(value => value.trim().toUpperCase()));
  const lots = new Map<string, PackingLot & { fromPacking: boolean }>();
  for (const row of rows) {
    if (row.status === "superseded" || row.status === "failed") continue;
    const data = row.extracted_data?.supplier_lots;
    if (!isSupplierLots(data)) continue;
    for (const item of data.items as SupplierLot[]) {
      const key = item.lot.trim().toUpperCase();
      if (!key || skip.has(key)) continue;
      const current = lots.get(key) ?? { lot: item.lot.trim(), description: item.description, quantity: null, expiry: null, packages: null, documents: [], fromPacking: false };
      if (item.quantity != null && (data.kind === "packing" || (!current.fromPacking && current.quantity == null))) {
        current.quantity = item.quantity;
        current.fromPacking = current.fromPacking || data.kind === "packing";
      }
      current.expiry = current.expiry ?? item.expiry;
      current.packages = current.packages ?? item.pallets ?? item.cartons;
      if (!current.description && item.description) current.description = item.description;
      const title = row.document?.title?.trim();
      if (title && !current.documents.includes(title)) current.documents.push(title);
      lots.set(key, current);
    }
  }
  return [...lots.values()].map((lot): PackingLot => ({ lot: lot.lot, description: lot.description, quantity: lot.quantity, expiry: lot.expiry,
    packages: lot.packages, documents: lot.documents })).sort((left, right) => left.lot.localeCompare(right.lot));
}

/** The first rows of the receiving form of an item: one per batch still expected, with the quantity of the packing list
 *  (all of the item for a single batch without one); none when nothing is expected. */
export type ReceivingRow = { expected: string; batch: string; expiry: string; manufactured: string; code: string | null };
export function receivingRows(itemQuantity: number, batches: ExpectedBatch[]): ReceivingRow[] {
  const open = batches.filter(batch => batch.state === "expected");
  return open.map(batch => ({
    expected: batch.quantity != null ? String(Number(batch.quantity)) : open.length === 1 ? String(itemQuantity) : "",
    batch: batch.batch, expiry: batch.expiry_date ?? "", manufactured: batch.manufacture_date ?? "", code: batch.label_code,
  }));
}

const day = (value: string) => value.split("-").reverse().join(".");

/** What the receipt did with the labels printed in advance for one truck: the batches whose labels stay unbound, and the
 *  batches that came with another expiry too (mixed up with the packing list) — those boxes must not carry its labels. */
export function receiptLabelWarnings(data: ShipmentExpected, transportId: string) {
  const items = data.items.filter(item => item.transport_id === transportId);
  const unbound = items.flatMap(item => item.batches.filter(batch => ["mismatch", "not_received", "missing"].includes(batch.state))
    .map(batch => `${item.sku} ${batch.batch} (${expectedStateLabel[batch.state]})`));
  const mixed = items.flatMap(item => item.batches.filter(batch => batch.state !== "cancelled" && batch.other_expiries.length)
    .map(batch => `${item.sku} ${batch.batch} — ещё со сроком ${batch.other_expiries.map(day).join(", ")}`));
  return [
    unbound.length ? `Наклейки по упаковочному листу не привязаны: ${unbound.join(", ")} — напечатайте наклейки принятых партий.` : "",
    mixed.length ? `Пересорт по сроку: ${mixed.join("; ")}. На коробки с другим сроком наклейки из листа не клеить — напечатайте им свои.` : "",
  ].filter(Boolean).join(" ");
}
