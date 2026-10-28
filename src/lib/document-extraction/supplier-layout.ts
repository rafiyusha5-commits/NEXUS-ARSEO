import type { CommodityInvoice, CommodityLine } from "./commodity-evidence.ts";
import type { PackingEvidence } from "./packing-evidence.ts";

export const SUPPLIER_LAYOUT_MARKER = "\n--- SUPPLIER TABLE LAYOUT ---\n";
export const isSupplierLayout = (text: string) => /Trolli\s+GmbH/iu.test(text) && /(?:Invoice\s*\|?\s*\d+|Delivery Note\s+\d+)/iu.test(text);

// This template prints English monetary/carton totals. Do not guess the locale
// of its separate German-format line weights or treat pallet factors as pack size.
export function englishAmount(value: string | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,3})?$/u.test(text)) return null;
  const result = Number(text.replace(/,/gu, ""));
  return Number.isFinite(result) ? result : null;
}
const unique = (values: string[]) => { const set = [...new Set(values)]; return set.length === 1 ? set[0] : null; };
const oneAmount = (text: string, pattern: RegExp) => {
  const values = [...text.matchAll(pattern)].map(m => m[1]);
  return values.length === 1 ? englishAmount(values[0]) : null;
};
const packSize = (description: string) => {
  const sizes = [...description.matchAll(/\b(\d+)\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b/giu)];
  const size = sizes.length === 1 ? Number(sizes[0][1]) : null;
  return size !== null && Number.isSafeInteger(size) && size > 0 ? size : null;
};
const amountLine = (number: number, sku: string, description: string): CommodityLine => ({ number, sku, description, quantity: null, unit: "piece", amount: null, hsCode: null, grossKg: null, netKg: null, customsValue: null, warnings: [] });

export function parseSupplierLayout(raw: string) {
  if (!isSupplierLayout(raw)) return null;
  const layout = raw.split(SUPPLIER_LAYOUT_MARKER)[1];
  if (!layout) return null;
  const packingDocument = /Delivery Note\s+\d+/u.test(layout);
  const fields: Record<string, string | number> = {};
  const warnings: string[] = [];
  const headers = [...layout.matchAll(packingDocument ? /Delivery Note\s+(\d+)/gu : /^Invoice\s*\|\s*(\d+)\s*$/gmu)].map(m => m[1]);
  const number = unique(headers);
  if (number) fields[packingDocument ? "packing_list_number" : "invoice_number"] = number;
  else warnings.push("Номер документа не определён однозначно.");
  if (!packingDocument) {
    const printed = layout.match(/^Issue Date\s*\|\s*(\d{2})\s+([A-Za-z]+)\s+(\d{4})\s*$/mu);
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    if (printed && months.includes(printed[2])) {
      const iso = `${printed[3]}-${String(months.indexOf(printed[2]) + 1).padStart(2, "0")}-${printed[1]}`;
      const date = new Date(iso + "T00:00:00Z");
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso) fields.invoice_date = iso;
    }
  }
  const delivery = layout.match(/Delivery terms\s*\|\s*(EXW|FCA|DAP|DDP|CPT|CIP|FOB|CIF)\s*\|\s*(?:Destination\s*\|\s*)?([^\n|]+)/iu);
  if (delivery) fields.incoterms = `${delivery[1].toUpperCase()} ${delivery[2].trim()}`;
  const gross = oneAmount(layout, packingDocument ? /^Total gross:\s*\|\s*([\d,.]+)\s*\|\s*KG/gmu : /^Gross weight:\s*\|\s*([\d,.]+)\s*\|\s*KG/gmu);
  if (gross !== null) fields.gross_weight_kg = gross;
  const net = oneAmount(layout, /^Net weight:\s*\|\s*([\d,.]+)\s*\|\s*KG/gmu);
  if (net !== null) fields.net_weight_kg = net;
  const pallets = oneAmount(layout, packingDocument ? /^Euro-Palette[^|\n]*\|\s*([\d,.]+)\s*$/gmu : /\bPallets:\s*\|\s*([\d,.]+)\s*$/gmu);
  if (pallets !== null && Number.isSafeInteger(pallets)) fields.pallet_count = pallets;
  const blocks = [...layout.matchAll(/^\s*(\d{1,4})\s*\|\s*(\d{5,10})(?:\s*\|[^\n]*)?\s*$/gmu)];
  const invoice: CommodityInvoice = { number, currency: unique([...layout.matchAll(/^Currency\s*\|\s*([A-Z]{3})\s*$/gmu)].map(m => m[1])), total: oneAmount(layout, /^Final amount:\s*\|\s*([\d,.]+)\s*$/gmu), items: [], warnings };
  const packing: PackingEvidence = { number, items: [], total: null, warnings };
  let cartons = 0;
  for (let index = 0; index < blocks.length; index++) {
    const match = blocks[index];
    const block = layout.slice(match.index!, blocks[index + 1]?.index ?? layout.length);
    const description = block.split(/\r?\n/u).slice(0, 3).find(line => /\d+\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b/iu.test(line)) ?? "";
    const size = packSize(description);
    const item = amountLine(index + 1, match[2], description.split("|").map(v => v.trim()).find(v => /[x×]/u.test(v)) ?? "");
    if (Number(match[1]) !== (index + 1) * 10 || blocks.filter(m => m[2] === match[2]).length !== 1) warnings.push("Нумерация или артикул строки документа повторяется либо пропущен.");
    if (!size) item.warnings.push("Не прочитана упаковка товара: штуки в коробе не определены.");
    if (packingDocument) {
      const lots = [...block.matchAll(/^\s*(\d{8,12})\s*\|\s*(\d{2}\.\d{2}\.\d{4})\s*\|\s*([^|\n]+)\s*\|\s*CAR\s*$/gmu)];
      const carLines = block.split(/\r?\n/u).filter(line => /\|\s*CAR\s*$/u.test(line));
      if (!lots.length || lots.length !== carLines.length || new Set(lots.map(m => m[1])).size !== lots.length) item.warnings.push("Строки партий упаковочного листа прочитаны не полностью или повторяются.");
      for (const lot of lots) {
        const quantity = englishAmount(lot[3]);
        if (quantity === null || !Number.isSafeInteger(quantity) || quantity <= 0 || size === null || !Number.isSafeInteger(quantity * size)) { item.warnings.push("Количество коробов или упаковка требуют проверки."); continue; }
        cartons += quantity;
        packing.items.push({ sku: item.sku!, quantity: quantity * size, unit: "piece" });
      }
    } else {
      const quantity = oneAmount(block, /^\s*([\d,.]+)\s*\|\s*CAR\s*$/gmu);
      const prices = [...block.matchAll(/^Price\s*\|\s*([\d,.]+)\s*\|\s*([A-Z]{3})\s*\|\s*per\s*\|\s*1\s*\|\s*BAG\s*\|\s*([\d,.]+)\s*$/gmu)];
      if (prices.length !== block.split(/\r?\n/u).filter(line => /^Price\s*\|/u.test(line)).length) item.warnings.push("Не все строки цены прочитаны.");
      const priceKey = unique(prices.map(p => `${p[1]}|${p[2]}|${p[3]}`));
      if (quantity !== null && Number.isSafeInteger(quantity) && quantity > 0) { cartons += quantity; if (size && Number.isSafeInteger(quantity * size)) item.quantity = quantity * size; }
      if (priceKey) {
        const [price, currency, total] = priceKey.split("|");
        item.amount = englishAmount(total);
        const unitPrice = englishAmount(price);
        if (currency !== invoice.currency || unitPrice === null || item.amount === null || item.quantity === null || Math.abs(item.quantity * unitPrice - item.amount) > 0.011) item.warnings.push("Количество × цена не подтверждает сумму строки.");
      } else item.warnings.push("Цена или сумма строки не определены однозначно.");
      item.hsCode = block.match(/Customs tariff no\.:\s*\|\s*(\d{8,10})/u)?.[1] ?? null;
      invoice.items.push(item);
    }
    warnings.push(...item.warnings);
  }
  const totalCartons = oneAmount(layout, packingDocument ? /^Carton:\s*\|\s*([\d,.]+)\s*$/gmu : /Total Quantity:\s*\n\s*([\d,.]+)\s*\|\s*CAR/gmu);
  if (!blocks.length || totalCartons === null || cartons !== totalCartons) warnings.push("Сумма коробов не подтверждает полноту документа.");
  if (packingDocument) {
    if (!warnings.length) packing.total = packing.items.reduce((sum, item) => sum + item.quantity, 0);
  } else if (!invoice.currency || invoice.total === null || invoice.items.some(item => item.amount === null) || Math.abs(invoice.items.reduce((sum, item) => sum + (item.amount ?? 0), 0) - invoice.total) > 0.011) warnings.push("Сумма строк не подтверждает итог инвойса.");
  return { fields, invoice: packingDocument ? null : invoice, packing: packingDocument ? packing : null };
}
