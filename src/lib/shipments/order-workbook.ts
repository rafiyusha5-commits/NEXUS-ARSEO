// «Вн расчеты» of an order folder (2026-11-22): what Nexus reads from the internal order workbook. Pure functions; the
// sheets are read by the server (Google Sheets, read only) and every change is shown to the employee before it is saved.
// Taken: the supplier order lines of the «Расчеты» sheet (ARSEO article, factory article, EAN, purchase quantity and
// invoice price), the factory loading date and the DC unloading date above them, and the client order of «От клиента».
// Not taken: «Экономика», «MasterData», sales prices and margins.
import type { Cell } from "../reference-import/normalize.ts";

export type WorkbookLine = { row: number; sku: string; factorySku: string; ean: string; name: string; quantity: number; price: number | null };
export type OrderWorkbook = {
  lines: WorkbookLine[];
  loadingDate: string | null;
  unloadingDate: string | null;
  clientOrder: { number: string | null; date: string | null; contract: string | null; contractDate: string | null };
  warnings: string[];
};

const norm = (value: Cell | undefined) => String(value ?? "").normalize("NFKC").toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();
const text = (value: Cell | undefined) => String(value ?? "").replace(/\s+/g, " ").trim();

/** A number as Google Sheets returns it unformatted, or as text with spaces, a comma or a currency sign. */
export function workbookNumber(value: Cell | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value).replace(/[€$₸\s ]/g, "").replace(",", ".");
  if (!raw || !/^-?\d+(\.\d+)?$/.test(raw)) return null;
  return Number(raw);
}

/** An article written as a number or with group spaces ("100 001") becomes "100001". */
export function workbookArticle(value: Cell | undefined): string {
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : "";
  return text(value).replace(/\s+/g, "");
}

/** dd.mm.yyyy or dd/mm/yyyy (the sheet's Russian locale) as an ISO date; anything else is no date. */
export function workbookDate(value: Cell | undefined): string | null {
  const match = text(value).match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!match) return null;
  const [day, month, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/** The value written under a label cell ("Дата погрузки на заводе" with the date in the cell below). */
function below(rows: Cell[][], label: RegExp, before: number): Cell | undefined {
  for (let r = 0; r < before; r++) {
    const c = (rows[r] ?? []).findIndex(cell => label.test(norm(cell)));
    if (c >= 0) for (let next = r + 1; next < before; next++) { const value = rows[next]?.[c]; if (text(value)) return value; }
  }
  return undefined;
}

/** The value to the right of a label cell ("Номер контракта/Contract number" | "SYN-1"). */
function right(rows: Cell[][], label: RegExp): string | null {
  for (const row of rows) {
    const c = row.findIndex(cell => label.test(norm(cell)));
    if (c >= 0) { const value = row.slice(c + 1).find(cell => text(cell)); if (value !== undefined) return text(value) || null; }
  }
  return null;
}

export function parseOrderWorkbook(calculation: Cell[][], client: Cell[][] = []): OrderWorkbook {
  const header = calculation.slice(0, 15).findIndex(row => row.some(cell => norm(cell) === "артикул arseo"));
  if (header < 0) throw new Error("В листе «Расчеты» не найдена строка заголовков с «Артикул ARSEO»");
  const labels = (calculation[header] ?? []).map(norm);
  const column = (pattern: RegExp, from = 0) => { const index = labels.findIndex((label, i) => i >= from && pattern.test(label)); return index; };
  const sku = column(/^артикул arseo$/), factory = column(/^артикул завода$/), ean = column(/^штрих ?код на товар$/), name = column(/^наименование \(рус\)$/);
  const price = column(/^цена за ед, евро.*invoice/);
  const quantity = price >= 0 ? column(/^заказ, шт$/, price + 1) : -1;
  if (sku < 0 || price < 0 || quantity < 0) throw new Error("В листе «Расчеты» не найдены столбцы закупа: «Цена за ед, евро (INVOICE)» и «Заказ, шт» после неё");
  const warnings: string[] = [];
  const lines: WorkbookLine[] = [];
  for (let r = header + 1; r < calculation.length; r++) {
    const row = calculation[r] ?? [];
    const line = { row: r + 1, sku: workbookArticle(row[sku]), factorySku: factory >= 0 ? workbookArticle(row[factory]) : "",
      ean: ean >= 0 ? workbookArticle(row[ean]).replace(/\D/g, "") : "", name: name >= 0 ? text(row[name]).slice(0, 300) : "",
      quantity: workbookNumber(row[quantity]) ?? 0, price: workbookNumber(row[price]) };
    if (!line.sku && !line.factorySku && !line.ean) continue;
    if (line.quantity <= 0) continue;
    if (!Number.isInteger(line.quantity)) warnings.push(`Строка ${line.row}: дробное количество ${line.quantity}`);
    if (line.price !== null && line.price < 0) { warnings.push(`Строка ${line.row}: отрицательная цена не взята`); line.price = null; }
    lines.push(line);
  }
  if (lines.length > 500) throw new Error("В листе «Расчеты» больше 500 строк заказа");
  return {
    lines, warnings,
    loadingDate: workbookDate(below(calculation, /^дата погрузки на заводе$/, header)),
    unloadingDate: workbookDate(below(calculation, /^дата выгрузки на рц$/, header)),
    clientOrder: {
      number: right(client, /^номер заказа/), date: workbookDate(right(client, /^дата заказа/) ?? undefined),
      contract: right(client, /^номер контракта/), contractDate: workbookDate(right(client, /^дата контракта/) ?? undefined),
    },
  };
}

export type ProductKeys = { id: string; sku: string; supplierSkus: string[]; eans: string[] };
export type ExistingItem = { id: string; product_id: string; quantity: number; price: number | null; transport: string | null };
export type LinePlan =
  | { kind: "add"; line: WorkbookLine; productId: string; by: string }
  | { kind: "update"; line: WorkbookLine; productId: string; by: string; itemId: string; quantity: number; price: number | null }
  | { kind: "same"; line: WorkbookLine; productId: string; by: string }
  | { kind: "split"; line: WorkbookLine; productId: string; by: string; quantity: number }
  | { kind: "unknown"; line: WorkbookLine; reason: string };

/** ARSEO article first, then the factory article of this supplier, then the unit EAN; ambiguous keys match nothing. */
export function matchLine(line: WorkbookLine, products: readonly ProductKeys[]): { id: string; by: string } | { reason: string } {
  const tries: [string, (p: ProductKeys) => boolean][] = [
    ["артикул ARSEO", p => !!line.sku && p.sku.replace(/\s+/g, "") === line.sku],
    ["артикул завода", p => !!line.factorySku && p.supplierSkus.some(value => value.replace(/\s+/g, "") === line.factorySku)],
    ["штрихкод", p => !!line.ean && p.eans.includes(line.ean)],
  ];
  for (const [by, test] of tries) {
    const found = products.filter(test);
    if (found.length === 1) return { id: found[0].id, by };
    if (found.length > 1) return { reason: `${by} подходит нескольким товарам` };
  }
  return { reason: "товар не найден в справочнике" };
}

const same = (a: number | null, b: number | null) => a === b || (a !== null && b !== null && Math.abs(a - b) < 0.00005);

/** What applying the workbook would do with each line, compared with the shipment's current items. */
export function planLines(lines: readonly WorkbookLine[], products: readonly ProductKeys[], items: readonly ExistingItem[]): { plans: LinePlan[]; notInWorkbook: ExistingItem[] } {
  const used = new Set<string>();
  const plans = lines.map((line): LinePlan => {
    const match = matchLine(line, products);
    if ("reason" in match) return { kind: "unknown", line, reason: match.reason };
    if (used.has(match.id)) return { kind: "unknown", line, reason: "товар повторяется в листе — объедините строки" };
    used.add(match.id);
    const rows = items.filter(item => item.product_id === match.id);
    if (!rows.length) return { kind: "add", line, productId: match.id, by: match.by };
    const quantity = rows.reduce((sum, item) => sum + item.quantity, 0);
    // Lines split across vehicles are changed on the vehicles, not here.
    if (rows.length > 1) return { kind: "split", line, productId: match.id, by: match.by, quantity };
    const [item] = rows;
    if (same(item.quantity, line.quantity) && (line.price === null || same(item.price, line.price))) return { kind: "same", line, productId: match.id, by: match.by };
    return { kind: "update", line, productId: match.id, by: match.by, itemId: item.id, quantity: item.quantity, price: item.price };
  });
  return { plans, notInWorkbook: items.filter(item => !used.has(item.product_id)) };
}

/** A workbook of an order folder: «Вн расчеты» anywhere in the name («HS-46 Вн. расчеты …», «Копия для расчетов … Вн расчеты …»). */
export function isOrderWorkbook(name: string, mimeType: string): boolean {
  return mimeType === "application/vnd.google-apps.spreadsheet" && /(?<!\p{L})вн\.?\s*расч[её]т/iu.test(name.normalize("NFKC"));
}

/** Order codes of a project code ("HS-48, HS-49", "Leib-12") as prefix and number. */
export function projectCodes(projectCode: string | null | undefined): { prefix: string; number: number }[] {
  return [...String(projectCode ?? "").matchAll(/(?<!\p{L})(\p{L}{1,12})(?:x|-|\s)?(\d{1,4})(?!\d)/gu)].map(match => ({ prefix: match[1], number: Number(match[2]) }));
}

/** Whether a file name carries one of the shipment's order codes («HS-50», «HS 50», «Leibx12»; «HS-500» is another order). */
export function namesOrder(name: string, codes: readonly { prefix: string; number: number }[]): boolean {
  // Prefixes are letters only (projectCodes), so they need no escaping in the pattern.
  const found = [...name.normalize("NFKC").matchAll(/(?<!\p{L})(\p{L}{1,12})(?:x|-|\s)?(\d{1,4})(?!\d)/gu)];
  // «Leibx12»: the letters before the number then end with the «x» separator.
  const same = (letters: string, prefix: string) => { const a = letters.toLocaleLowerCase("en"), b = prefix.toLocaleLowerCase("en"); return a === b || a === `${b}x`; };
  return codes.some(code => found.some(match => same(match[1], code.prefix) && Number(match[2]) === code.number));
}

/** The workbooks of this order when their names carry its code; otherwise every workbook of the folder. */
export function orderWorkbooks<T extends { name: string }>(workbooks: readonly T[], projectCode: string | null | undefined): T[] {
  const codes = projectCodes(projectCode);
  const own = codes.length ? workbooks.filter(file => namesOrder(file.name, codes)) : [];
  return own.length ? own : [...workbooks];
}
