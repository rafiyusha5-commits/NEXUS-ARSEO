import { normalizeProductName } from "../document-extraction/esf.ts";

// Quantities of a shipment taken from a confirmed invoice, packing list or waybill. The recognised lines only
// propose values: the employee checks every quantity against the original before it is written.

export type DocumentLine = { line_number?: number; product_name?: string; hs_code?: string; uom?: string; quantity?: number };
export type QuantityItem = {
  id: string;
  uom: string;
  shipment_transport_id: string | null;
  product: { internal_sku?: string | null; name?: unknown; hs_code?: string | null } | null;
};
export type QuantityProposal = {
  itemId: string;
  /** Proposed value in the unit of the shipment item; null when the employee has to enter it. */
  quantity: number | null;
  line: DocumentLine | null;
  matchedBy: "name" | "sku" | "hs_code" | null;
  /** The matched line is in another unit: shown as a hint, never converted silently. */
  unitMismatch: boolean;
};

export const QUANTITY_SOURCE_KINDS = new Set(["invoice", "specification", "waybill"]);

/** The field a document normally confirms: the invoice states what the supplier agreed, the rest what was loaded. */
export function defaultQuantityTarget(sourceKind: string) {
  return sourceKind === "invoice" ? "confirmed" : "shipped";
}

const UNIT_PATTERNS: Array<[string, RegExp]> = [
  ["piece", /^(шт|штук|штука|штуки|ед|единица|pcs?|pieces?|units?|ea)\.?$/iu],
  ["box", /^(кор|короб|коробка|коробок|коробки|упак|упаковка|box(es)?|cartons?|ctn|cs|case)\.?$/iu],
  ["layer", /^(слой|слоя|слоёв|layers?)\.?$/iu],
  ["pallet", /^(пал|паллета|паллеты|паллет|поддон|поддона|поддонов|pallets?|plt)\.?$/iu],
];

/** Unit of a document line as a Nexus unit code; null when it is unknown (kilograms, litres, free text). */
export function documentUnit(value: string | undefined | null) {
  const text = (value ?? "").trim();
  if (!text) return null;
  return UNIT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
}

function productNames(name: unknown) {
  if (!name || typeof name !== "object") return typeof name === "string" ? [name] : [];
  return Object.values(name as Record<string, unknown>).filter((value): value is string => typeof value === "string" && value.trim() !== "");
}

/**
 * Matches document lines to shipment items: by the full product name, then by the internal SKU written in the
 * line, then by an HS code that only one item and one line share. A line is used for one item at most and an
 * ambiguous match proposes nothing.
 */
export function proposeDocumentQuantities(items: readonly QuantityItem[], lines: readonly DocumentLine[]): QuantityProposal[] {
  const usable = lines.filter(line => typeof line.quantity === "number" && Number.isFinite(line.quantity) && line.quantity >= 0);
  const matches = new Map<string, { line: DocumentLine; by: QuantityProposal["matchedBy"] }>();
  const usedLines = new Set<DocumentLine>();

  const assign = (by: NonNullable<QuantityProposal["matchedBy"]>, candidates: (item: QuantityItem) => DocumentLine[]) => {
    const found = new Map<string, DocumentLine>();
    const claims = new Map<DocumentLine, number>();
    for (const item of items) {
      if (matches.has(item.id)) continue;
      const lineCandidates = candidates(item).filter(line => !usedLines.has(line));
      if (lineCandidates.length !== 1) continue;
      found.set(item.id, lineCandidates[0]);
      claims.set(lineCandidates[0], (claims.get(lineCandidates[0]) ?? 0) + 1);
    }
    for (const [itemId, line] of found) {
      if (claims.get(line) !== 1) continue;
      matches.set(itemId, { line, by });
      usedLines.add(line);
    }
  };

  assign("name", item => {
    const names = new Set(productNames(item.product?.name).map(normalizeProductName).filter(Boolean));
    return usable.filter(line => names.has(normalizeProductName(line.product_name ?? "")));
  });
  assign("sku", item => {
    const sku = normalizeProductName(item.product?.internal_sku ?? "");
    return sku.length >= 3 ? usable.filter(line => normalizeProductName(line.product_name ?? "").includes(sku)) : [];
  });
  assign("hs_code", item => {
    const hs = (item.product?.hs_code ?? "").replace(/\D/g, "");
    if (hs.length < 6) return [];
    const sameCode = items.filter(other => (other.product?.hs_code ?? "").replace(/\D/g, "") === hs);
    return sameCode.length === 1 ? usable.filter(line => (line.hs_code ?? "").replace(/\D/g, "") === hs) : [];
  });

  return items.map(item => {
    const match = matches.get(item.id);
    if (!match) return { itemId: item.id, quantity: null, line: null, matchedBy: null, unitMismatch: false };
    const unit = documentUnit(match.line.uom);
    const sameUnit = unit === item.uom;
    return { itemId: item.id, quantity: sameUnit ? Number(match.line.quantity) : null, line: match.line, matchedBy: match.by, unitMismatch: !sameUnit };
  });
}

/** Items a document may speak about: all of the shipment, or the cargo of the vehicle it belongs to. */
export function itemsInDocumentScope<T extends Pick<QuantityItem, "shipment_transport_id">>(items: readonly T[], transportId: string | null) {
  return transportId ? items.filter(item => item.shipment_transport_id === transportId) : [...items];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Form values → RPC lines. Empty inputs are skipped; anything else must be a non-negative number with at most
 * three decimals. Whether the item belongs to the document is checked by the database.
 */
export function parseQuantityLines(entries: Iterable<[string, unknown]>) {
  const lines: Array<{ shipment_item_id: string; quantity: number }> = [];
  for (const [key, raw] of entries) {
    if (!key.startsWith("qty_") || typeof raw !== "string") continue;
    const itemId = key.slice(4);
    const text = raw.trim().replace(/\s/g, "").replace(",", ".");
    if (!text) continue;
    if (!UUID.test(itemId)) throw new Error("Некорректная позиция поставки");
    const quantity = Number(text);
    if (!/^\d+(\.\d{1,3})?$/.test(text) || !Number.isFinite(quantity)) throw new Error("Количество должно быть неотрицательным числом не более чем с тремя знаками после запятой");
    lines.push({ shipment_item_id: itemId, quantity });
  }
  return lines;
}
