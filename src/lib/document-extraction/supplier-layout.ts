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
const descriptionOf = (block: string) => block.split(/\r?\n/u).slice(0, 3)
  .find(line => /\d+\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:g|kg|ml|l)\b/iu.test(line))
  ?.split("|").map(v => v.trim()).find(v => /[x×]/u.test(v)) ?? "";
const productFamily = (description: string) => description.replace(/^DP\s+/iu, "")
  .replace(/\b\d+\s*[x×]\s*/giu, "").replace(/\s+/gu, " ").trim().toLowerCase();
const tariff = (block: string) => block.match(/Customs tariff no\.:\s*\|\s*(\d{8,10})/u)?.[1] ?? null;
function readPrices(block: string, unit: "BAG" | "PC", item: CommodityLine, currency: string | null) {
  const prices = [...block.matchAll(/^Price\s*\|\s*([\d,.]+)\s*\|\s*([A-Z]{3})\s*\|\s*per\s*\|\s*1\s*\|\s*(BAG|PC)\s*\|\s*([\d,.]+)\s*$/gmu)];
  if (prices.length !== block.split(/\r?\n/u).filter(line => /^Price\s*\|/u.test(line)).length || prices.some(p => p[3] !== unit)) item.warnings.push("Не все строки цены прочитаны или различаются единицы цены.");
  const key = unique(prices.map(p => `${p[1]}|${p[2]}|${p[4]}`));
  if (!key) { item.warnings.push("Цена или сумма строки не определены однозначно."); return; }
  const [price, printedCurrency, total] = key.split("|");
  item.amount = englishAmount(total);
  const unitPrice = englishAmount(price);
  if (printedCurrency !== currency || unitPrice === null || item.amount === null || item.quantity === null || Math.abs(item.quantity * unitPrice - item.amount) > 0.011) item.warnings.push("Количество × цена не подтверждает сумму строки.");
}

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
  const blocks = [...layout.matchAll(/^\s*(\d{1,6})\s*\|\s*(\d{5,10})(?:\s*\|[^\n]*)?\s*$/gmu)];
  const invoice: CommodityInvoice = { number, currency: unique([...layout.matchAll(/^Currency\s*\|\s*([A-Z]{3})\s*$/gmu)].map(m => m[1])), total: oneAmount(layout, /^Final amount:\s*\|\s*([\d,.]+)\s*$/gmu), items: [], warnings };
  const packing: PackingEvidence = { number, items: [], total: null, warnings };
  const header = layout.slice(0, blocks[0]?.index ?? layout.length);
  const totalPieces = packingDocument ? oneAmount(layout, /^Pieces:\s*\|\s*([\d,.]+)\s*$/gmu) : oneAmount(header, /^\s*([\d,.]+)\s*\|\s*PC\s*$/gmu);
  let cartons = 0, displays = 0, invoiceDisplaySlots = 0;
  for (let index = 0; index < blocks.length; index++) {
    const match = blocks[index];
    const block = layout.slice(match.index!, blocks[index + 1]?.index ?? layout.length);
    const description = descriptionOf(block);
    const size = packSize(description);
    const item = amountLine(invoice.items.length + 1, match[2], description);
    if (Number(match[1]) !== (index + 1) * 10 + invoiceDisplaySlots || blocks.filter(m => m[2] === match[2]).length !== 1) warnings.push("Нумерация или артикул строки документа повторяется либо пропущен.");
    if (!size) item.warnings.push("Не прочитана упаковка товара: штуки в коробе не определены.");
    const display = /^DP\s+/iu.test(description);
    const child = blocks[index + 1];
    const childBody = child ? layout.slice(child.index!, blocks[index + 2]?.index ?? layout.length) : "";
    const childQuantity = oneAmount(childBody, /^\s*([\d,.]+)\s*\|\s*PC\s*$/gmu);
    const childMatches = Boolean(child && Number(child[1]) === Number(match[1]) + 10
      && child[2] !== match[2] && blocks.filter(m => m[2] === child[2]).length === 1
      && productFamily(descriptionOf(childBody)) === productFamily(description)
      && childQuantity !== null && Number.isSafeInteger(childQuantity) && childQuantity > 0);
    if (packingDocument) {
      const lots = [...block.matchAll(/^\s*([A-Z0-9]{8,12})\s*\|\s*(\d{2}\.\d{2}\.\d{4})\s*\|\s*([^|\n]+)\s*\|\s*(CAR|PC)\s*$/gmu)];
      const lotLines = block.split(/\r?\n/u).filter(line => /\|\s*(?:CAR|PC)\s*$/u.test(line));
      if (!lots.length || lots.length !== lotLines.length || new Set(lots.map(m => m[1])).size !== lots.length) item.warnings.push("Строки партий упаковочного листа прочитаны не полностью или повторяются.");
      let batchPieces = 0;
      for (const lot of lots) {
        const quantity = englishAmount(lot[3]);
        const date = lot[2].split(".").reverse().join("-");
        const validDate = new Date(date + "T00:00:00Z");
        if (quantity === null || !Number.isSafeInteger(quantity) || quantity <= 0 || size === null || !Number.isSafeInteger(quantity * size) || lot[4] !== (display ? "PC" : "CAR") || !Number.isFinite(validDate.getTime()) || validDate.toISOString().slice(0, 10) !== date) { item.warnings.push("Количество коробов, дата или упаковка требуют проверки."); continue; }
        if (display) displays += quantity; else cartons += quantity;
        batchPieces += quantity * size;
        packing.items.push({ sku: item.sku!, quantity: quantity * size, unit: "piece" });
      }
      if (display) {
        const parentRefs = [...childBody.matchAll(/^Parent item:\s*\|\s*(\d+)\s*$/gmu)];
        if (childMatches && parentRefs.length === 1 && Number(parentRefs[0][1]) === Number(match[1]) && childQuantity === batchPieces) index++;
        else item.warnings.push("Связь дисплея с вложенным товаром и количество не подтверждены.");
      }
    } else {
      item.hsCode = tariff(block);
      if (display) {
        // This supplier prints an unpriced DP parent, its indented PC-priced
        // component, and consumes a third item slot for the price/quantity block.
        // Require the single display header to prove the conversion independently.
        const onlyDisplay = blocks.filter((m, i) => /^DP\s+/iu.test(descriptionOf(layout.slice(m.index!, blocks[i + 1]?.index ?? layout.length)))).length === 1;
        if (childMatches && onlyDisplay && size && totalPieces !== null && Number.isSafeInteger(totalPieces) && totalPieces > 0 && totalPieces * size === childQuantity && item.hsCode && item.hsCode === tariff(childBody) && !/^Price\s*\|/mu.test(block) && !/^[\d,.]+\s*\|\s*(?:PC|CAR)\s*$/mu.test(block)) {
          displays += totalPieces;
          item.quantity = childQuantity;
          item.description += ` (содержимое ${child[2]})`;
          readPrices(childBody, "PC", item, invoice.currency);
          index++; invoiceDisplaySlots += 10;
        } else item.warnings.push("Связь дисплея с вложенным товаром и количество не подтверждены.");
      } else {
        const quantity = oneAmount(block, /^\s*([\d,.]+)\s*\|\s*CAR\s*$/gmu);
        if (quantity !== null && Number.isSafeInteger(quantity) && quantity > 0) { cartons += quantity; if (size && Number.isSafeInteger(quantity * size)) item.quantity = quantity * size; }
        readPrices(block, "BAG", item, invoice.currency);
      }
      invoice.items.push(item);
    }
    warnings.push(...item.warnings);
  }
  const totalCartons = packingDocument ? oneAmount(layout, /^Carton:\s*\|\s*([\d,.]+)\s*$/gmu) : oneAmount(header.split("Total Quantity:")[1] ?? "", /^\s*([\d,.]+)\s*\|\s*CAR\s*$/gmu);
  if (!blocks.length || totalCartons === null || cartons !== totalCartons || displays !== (totalPieces ?? 0)) warnings.push("Сумма коробов и дисплеев не подтверждает полноту документа.");
  if (packingDocument) {
    if (!warnings.length) packing.total = packing.items.reduce((sum, item) => sum + item.quantity, 0);
  } else if (!invoice.currency || invoice.total === null || invoice.items.some(item => item.amount === null) || Math.abs(invoice.items.reduce((sum, item) => sum + (item.amount ?? 0), 0) - invoice.total) > 0.011) warnings.push("Сумма строк не подтверждает итог инвойса.");
  return { fields, invoice: packingDocument ? null : invoice, packing: packingDocument ? packing : null };
}
