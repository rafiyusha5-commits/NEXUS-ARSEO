import { normalizeProductName } from "../document-extraction/esf.ts";

// Quantities of a shipment taken from a confirmed invoice, packing list or waybill. The recognised lines only
// propose values: the employee checks every quantity against the original before it is written.

export type DocumentLine = { line_number?: number; product_name?: string; sku?: string; hs_code?: string; uom?: string; quantity?: number };
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
  matchedBy: "name" | "sku" | null;
  review: string | null;
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

/** Exact identifiers keep punctuation: ABC-12 is not ABC-123 or ABC12. */
const identifier = (value: string) => value.normalize("NFKC").trim().toLocaleUpperCase("en-US");
const tokens = (value: string): string[] => identifier(value).match(/[\p{L}\p{N}]+(?:[-_/.][\p{L}\p{N}]+)*/gu) ?? [];

/** Analyse the whole document before proposing anything. A commodity code is never an identity. */
export function analyseDocumentQuantities(items: readonly QuantityItem[], lines: readonly DocumentLine[]) {
  const claims = new Map<string, Array<{ line: DocumentLine; by: "sku" | "name" }>>();
  const warnings: string[] = [];
  for (const [index, line] of lines.entries()) {
    const label = `Строка ${line.line_number ?? index + 1}`;
    const explicitSku = identifier(line.sku ?? "");
    const words = tokens(line.product_name ?? "");
    const bySku = items.filter(item => {
      const sku = identifier(item.product?.internal_sku ?? "");
      return sku && (explicitSku ? explicitSku === sku : words.includes(sku));
    });
    const name = normalizeProductName(line.product_name ?? "");
    const byName = name ? items.filter(item => productNames(item.product?.name).some(n => normalizeProductName(n) === name)) : [];
    const candidates = explicitSku || bySku.length ? bySku : byName;
    if (candidates.length !== 1 || (bySku.length && byName.length > 0 && !byName.some(item => item.id === bySku[0].id))) {
      warnings.push(`${label}: товар не определён однозначно; проверьте артикул и наименование.`);
      continue;
    }
    const item = candidates[0];
    const expectedHs = (item.product?.hs_code ?? "").replace(/\D/g, "");
    const actualHs = (line.hs_code ?? "").replace(/\D/g, "");
    if (expectedHs && actualHs && expectedHs !== actualHs) {
      warnings.push(`${label}: код ТН ВЭД противоречит найденному товару.`); continue;
    }
    if (typeof line.quantity !== "number" || !Number.isFinite(line.quantity) || line.quantity < 0) {
      warnings.push(`${label}: количество не прочитано.`); continue;
    }
    const rows = claims.get(item.id) ?? [];
    rows.push({ line, by: bySku.length ? "sku" : "name" });
    claims.set(item.id, rows);
  }
  for (const item of items) {
    if ((claims.get(item.id)?.length ?? 0) > 1) warnings.push(`Товар ${item.product?.internal_sku ?? item.id}: несколько строк; проверьте партии и полное количество по оригиналу.`);
  }
  const proposals: QuantityProposal[] = items.map(item => {
    const rows = claims.get(item.id) ?? [];
    const match = rows.length === 1 ? rows[0] : null;
    const unitMismatch = Boolean(match && documentUnit(match.line.uom) !== item.uom);
    const review = warnings.length ? "Есть несопоставленные или неоднозначные строки: автоматическая подстановка отключена для всего документа."
      : unitMismatch ? "Единица отличается или не распознана: требуется ручная сверка."
      : !match ? "Строка товара не найдена: введите количество только после сверки." : null;
    return { itemId: item.id, quantity: match && !review ? match.line.quantity! : null,
      line: match?.line ?? null, matchedBy: match?.by ?? null, unitMismatch, review };
  });
  return { proposals, warnings };
}

export function proposeDocumentQuantities(items: readonly QuantityItem[], lines: readonly DocumentLine[]): QuantityProposal[] {
  return analyseDocumentQuantities(items, lines).proposals;
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
