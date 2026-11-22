// Phase 2 of the Drive order folder (2026-11-22): the «Растаможка», «Стикеры» and «Распределение» sheets of an order.
// Pure functions over sheet values. Customs and stickers are checks only; the distribution can become draft client
// orders after the employee reviews them (prices then come from the price list, never from the sheet).
import type { Cell } from "../reference-import/normalize.ts";
import { workbookArticle, workbookNumber } from "./order-workbook.ts";

const norm = (value: Cell | undefined) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const text = (value: Cell | undefined) => String(value ?? "").replace(/\s+/g, " ").trim();

function headerRow(rows: Cell[][], pattern: RegExp, within = 15) {
  return rows.slice(0, within).findIndex(row => row.some(cell => pattern.test(norm(cell))));
}
const find = (labels: string[], pattern: RegExp) => labels.findIndex(label => pattern.test(label));

// ── «Растаможка» ────────────────────────────────────────────────────────────────────────────────────────────────
export type CustomsLine = { row: number; article: string; ean: string; hsCode: string; country: string; price: number | null; quantity: number; netKg: number | null };

export function parseCustomsSheet(rows: Cell[][]): CustomsLine[] {
  const header = headerRow(rows, /^тнвэд$/);
  if (header < 0) return [];
  const labels = (rows[header] ?? []).map(norm);
  const article = find(labels, /^артикул/), ean = find(labels, /^штрих ?код/), hs = find(labels, /^тнвэд$/), country = find(labels, /^страна происхождения/);
  const price = find(labels, /^цена в инвойсе/), quantity = find(labels, /^кол-во по инвойсу, шт/), net = find(labels, /^вес нетто за ед/);
  if (hs < 0 || quantity < 0) return [];
  const lines: CustomsLine[] = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const line = { row: r + 1, article: article >= 0 ? workbookArticle(row[article]) : "", ean: ean >= 0 ? workbookArticle(row[ean]).replace(/\D/g, "") : "",
      hsCode: workbookArticle(row[hs]).replace(/\D/g, ""), country: country >= 0 ? text(row[country]) : "", price: price >= 0 ? workbookNumber(row[price]) : null,
      quantity: workbookNumber(row[quantity]) ?? 0, netKg: net >= 0 ? workbookNumber(row[net]) : null };
    if ((line.article || line.ean) && line.quantity > 0) lines.push(line);
  }
  return lines;
}

// Country names as the sheets write them → ISO codes used by the product card.
const COUNTRIES: Record<string, string> = { finland: "FI", "финляндия": "FI", netherlands: "NL", "нидерланды": "NL", germany: "DE", "германия": "DE",
  poland: "PL", "польша": "PL", turkey: "TR", "турция": "TR", "türkiye": "TR", italy: "IT", "италия": "IT", belgium: "BE", "бельгия": "BE",
  russia: "RU", "россия": "RU", kazakhstan: "KZ", "казахстан": "KZ", georgia: "GE", "грузия": "GE", spain: "ES", "испания": "ES", france: "FR", "франция": "FR" };
export function countryCode(value: string): string | null {
  const key = norm(value);
  if (/^[a-z]{2}$/.test(key)) return key.toUpperCase();
  return COUNTRIES[key] ?? null;
}

export type CustomsIssue = { row: number; article: string; field: string; sheet: string; nexus: string };
export type CustomsProduct = { id: string; hs_code: string | null; country_of_origin: string | null };

/** Differences between the customs sheet and Nexus: the product card (HS code, country) and the shipment line (quantity, price). */
export function customsIssues(lines: readonly CustomsLine[], productOf: (line: CustomsLine) => CustomsProduct | null,
  itemOf: (productId: string) => { quantity: number; price: number | null } | null): CustomsIssue[] {
  const issues: CustomsIssue[] = [];
  const fmt = (value: number | null) => value === null ? "—" : String(value);
  for (const line of lines) {
    const product = productOf(line);
    if (!product) { issues.push({ row: line.row, article: line.article || line.ean, field: "Товар", sheet: line.article || line.ean, nexus: "не найден в справочнике" }); continue; }
    // An 8-digit CN code of the supplier and the 10-digit EAEU code of the card agree when one starts with the other.
    const card = (product.hs_code ?? "").replace(/\D/g, "");
    if (line.hsCode && !(card && (card.startsWith(line.hsCode) || line.hsCode.startsWith(card))))
      issues.push({ row: line.row, article: line.article, field: "ТН ВЭД", sheet: line.hsCode, nexus: product.hs_code || "не заполнен" });
    const country = countryCode(line.country);
    if (line.country && country !== product.country_of_origin)
      issues.push({ row: line.row, article: line.article, field: "Страна происхождения", sheet: line.country, nexus: product.country_of_origin || "не заполнена" });
    const item = itemOf(product.id);
    if (!item) { issues.push({ row: line.row, article: line.article, field: "Позиция поставки", sheet: `${line.quantity} шт`, nexus: "нет в поставке" }); continue; }
    if (Math.abs(item.quantity - line.quantity) > 0.0005) issues.push({ row: line.row, article: line.article, field: "Количество, шт", sheet: fmt(line.quantity), nexus: fmt(item.quantity) });
    if (line.price !== null && (item.price === null || Math.abs(item.price - line.price) > 0.00005))
      issues.push({ row: line.row, article: line.article, field: "Цена в инвойсе", sheet: fmt(line.price), nexus: fmt(item.price) });
  }
  return issues;
}

// ── «Стикеры» ───────────────────────────────────────────────────────────────────────────────────────────────────
export type StickerLine = { row: number; sku: string; ean: string; unitStickers: number; boxStickers: number };

export function parseStickerSheet(rows: Cell[][]): { lines: StickerLine[]; size: string | null; marking: string | null } {
  const header = headerRow(rows, /^стикеры индивидуальные$/);
  if (header < 0) return { lines: [], size: null, marking: null };
  const labels = (rows[header] ?? []).map(norm);
  const sku = find(labels, /^артикул arseo$/), ean = find(labels, /^штрих ?код на товар$/), unit = find(labels, /^стикеры индивидуальные$/), box = find(labels, /^стикеры коробочные$/);
  const lines: StickerLine[] = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const line = { row: r + 1, sku: sku >= 0 ? workbookArticle(row[sku]) : "", ean: ean >= 0 ? workbookArticle(row[ean]).replace(/\D/g, "") : "",
      unitStickers: workbookNumber(row[unit]) ?? 0, boxStickers: box >= 0 ? workbookNumber(row[box]) ?? 0 : 0 };
    if ((line.sku || line.ean) && (line.unitStickers > 0 || line.boxStickers > 0)) lines.push(line);
  }
  // «размер стикера» and «с ЧЗ/без ЧЗ» are labels with the value in the cell below.
  const under = (pattern: RegExp) => { for (let r = 0; r < header; r++) { const c = (rows[r] ?? []).findIndex(cell => pattern.test(norm(cell))); if (c >= 0) return text(rows[r + 1]?.[c]) || null; } return null; };
  return { lines, size: under(/^размер стикера$/), marking: under(/^с чз\/без чз$/) };
}

// ── «Распределение» ─────────────────────────────────────────────────────────────────────────────────────────────
export type Destination = { column: number; label: string; kind: "sale" | "warehouse"; name: string };
export type DistributionLine = { row: number; orderCode: string; sku: string; factorySku: string; ean: string; received: number; quantities: Record<number, number> };
export type Distribution = { destinations: Destination[]; lines: DistributionLine[] };

/** Groups are the merged labels above the header row («ПРИХОД», «Продажа в …», a warehouse); each has its «Заказ, шт». */
export function parseDistributionSheet(rows: Cell[][]): Distribution {
  const header = headerRow(rows, /^заказ, шт$/);
  if (header < 1) return { destinations: [], lines: [] };
  const labels = (rows[header] ?? []).map(norm);
  const groups = (rows[header - 1] ?? []).map((cell, column) => ({ column, label: text(cell) })).filter(group => group.label);
  const groupOf = (column: number) => [...groups].reverse().find(group => group.column <= column);
  const destinations: Destination[] = []; let receivedColumn = -1;
  labels.forEach((label, column) => {
    if (label !== "заказ, шт") return;
    const group = groupOf(column); if (!group) return;
    const name = norm(group.label);
    if (/^приход/.test(name)) { receivedColumn = column; return; }
    if (/машина|заказ поставщику/.test(name)) return;
    const sale = group.label.match(/^продажа\s+(?:в|для)\s+(.+)$/i);
    destinations.push({ column, label: group.label, kind: sale ? "sale" : "warehouse", name: (sale ? sale[1] : group.label).trim() });
  });
  const code = find(labels, /^(заказ ?№|номер заказа)$/);
  const sku = find(labels, /^артикул arseo$/), factory = find(labels, /^артикул завода$/), ean = find(labels, /^штрих ?код на товар$/);
  const lines: DistributionLine[] = [];
  for (let r = header + 1; r < rows.length; r++) {
    const row = rows[r] ?? [];
    const quantities: Record<number, number> = {};
    for (const destination of destinations) { const value = workbookNumber(row[destination.column]); if (value && value > 0) quantities[destination.column] = value; }
    // Without an order-number column the code is the first text cell that looks like one («AB-40»).
    const orderCode = code >= 0 ? text(row[code]) : text(row.find(cell => /^[A-Za-z]{1,12}[-x ]?\d{1,4}$/.test(text(cell))));
    const line = { row: r + 1, orderCode, sku: sku >= 0 ? workbookArticle(row[sku]) : "", factorySku: factory >= 0 ? workbookArticle(row[factory]) : "",
      ean: ean >= 0 ? workbookArticle(row[ean]).replace(/\D/g, "") : "", received: receivedColumn >= 0 ? workbookNumber(row[receivedColumn]) ?? 0 : 0, quantities };
    if ((line.sku || line.factorySku || line.ean) && (line.received > 0 || Object.keys(quantities).length)) lines.push(line);
  }
  return { destinations, lines };
}

/** Lines whose destinations add up to more than arrived: a distribution error to fix in the sheet. */
export function overDistributed(distribution: Distribution): DistributionLine[] {
  return distribution.lines.filter(line => line.received > 0 && Object.values(line.quantities).reduce((sum, value) => sum + value, 0) > line.received + 0.0005);
}

/** A customer whose short or legal name equals the destination name, ignoring case, quotes and legal form. */
export function matchCustomer(name: string, customers: readonly { id: string; legal_name: string; short_name?: string | null }[]): string | null {
  const clean = (value: string) => norm(value).replace(/[«»"'`]/g, "").replace(/^(ооо|тоо|осоо|ип|llc|ltd)\s+/, "").trim();
  const target = clean(name);
  const found = customers.filter(customer => [customer.short_name ?? "", customer.legal_name].some(value => value && clean(value) === target));
  return found.length === 1 ? found[0].id : null;
}

/** A separate distribution spreadsheet of the order folder («Распределение …»). */
export function isDistributionSheet(name: string, mimeType: string): boolean {
  return mimeType === "application/vnd.google-apps.spreadsheet" && /^распределение/i.test(name.trim());
}
