// Warehouse operations from a phone (202611280600): what order_pick_list returns and the matching of a scan to the work
// at hand. Rendering and guidance only: every rule is checked by the database (a foreign batch is refused there too).
import type { ScanResult } from "./lookup.ts";

export type PickLine = {
  reservation_id: string; sku: string; product: string; product_id: string; batch_id: string; batch: string; expiry_date: string | null;
  location_id: string | null; location: string | null; uom: string; quantity: string; picked: string;
};
export type PickList = { sale_id: string; sale_number: string; status: string; customer: string | null; can_replace: boolean; lines: PickLine[] };

export const remaining = (line: PickLine) => Math.max(0, Math.round((Number(line.quantity) - Number(line.picked)) * 1000) / 1000);
export const pickDone = (list: PickList) => list.lines.length > 0 && list.lines.every(line => remaining(line) === 0);
/** The next line to pick: the lines come in the order of places, so this is the walk through the warehouse. */
export const nextPick = (list: PickList) => list.lines.find(line => remaining(line) > 0) ?? null;

/** The batches a scan names: a batch label, or a product code narrowed to a batch (GS1 (10) or the number typed). A
 *  product code without a batch names none: the batch has to be confirmed. */
export function scannedBatches(result: ScanResult | null, batchNumber?: string | null): string[] {
  if (!result) return [];
  if (result.kind === "batch") return [result.batch.id];
  if (result.kind === "product" && batchNumber) {
    return [...new Set(result.products.flatMap(product => product.stock.filter(row => row.batch === batchNumber).map(row => row.batch_id)))];
  }
  return [];
}

export type PickMatch =
  | { kind: "pick"; line: PickLine; other_expiries?: string[] }
  | { kind: "done"; line: PickLine }
  | { kind: "foreign"; batch: string | null; expected: PickLine | null }
  | { kind: "need_batch"; product: string }
  | { kind: "not_found" };

/** What a scan means for the pick list: the line to confirm, a line already picked, a batch that is not reserved. */
export function matchPick(list: PickList, result: ScanResult | null, batchNumber?: string | null): PickMatch {
  if (!result || result.kind === "unknown" || result.kind === "location") return { kind: "not_found" };
  // A label printed in advance whose batch is not received under it: nothing of it is in stock, so nothing is reserved.
  if (result.kind === "expected") {
    const product = result.expected.product_id;
    return { kind: "foreign", batch: result.expected.batch,
      expected: list.lines.find(line => remaining(line) > 0 && line.product_id === product) ?? nextPick(list) };
  }
  const batches = scannedBatches(result, batchNumber);
  if (!batches.length) {
    if (result.kind === "product" && !batchNumber) return { kind: "need_batch", product: result.products[0]?.product ?? result.code };
    const productIds = result.kind === "product" ? result.products.map(product => product.product_id) : [];
    const expected = list.lines.find(line => remaining(line) > 0 && productIds.includes(line.product_id)) ?? nextPick(list);
    return { kind: "foreign", batch: batchNumber ?? null, expected };
  }
  const open = list.lines.find(line => batches.includes(line.batch_id) && remaining(line) > 0);
  // The same number with another expiry in stock (a batch mixed up by expiry): the box is compared with the label.
  const others = result.kind === "batch" ? result.batch.other_expiries ?? [] : [];
  if (open) return others.length ? { kind: "pick", line: open, other_expiries: others } : { kind: "pick", line: open };
  const done = list.lines.find(line => batches.includes(line.batch_id));
  if (done) return { kind: "done", line: done };
  const name = result.kind === "batch" ? result.batch.batch : batchNumber ?? null;
  const product = result.kind === "batch" ? result.batch.product_id : null;
  const expected = list.lines.find(line => remaining(line) > 0 && (product ? line.product_id === product : true)) ?? nextPick(list);
  return { kind: "foreign", batch: name, expected };
}

/** GTIN-8/12/13/14 and plain barcodes compared as 14 digits: a GTIN-13 and the same GTIN-14 with a leading zero match. */
export function normalizeCode(value: string) {
  const code = value.trim();
  return /^\d{8,14}$/.test(code) ? code.padStart(14, "0") : code.toUpperCase();
}

export type ReceivingProduct = { item_id: string; codes: string[] };
/** The receiving items whose product carries the scanned code. */
export function matchReceiving(items: ReceivingProduct[], code: string) {
  const wanted = normalizeCode(code);
  return items.filter(item => item.codes.some(value => normalizeCode(value) === wanted)).map(item => item.item_id);
}
