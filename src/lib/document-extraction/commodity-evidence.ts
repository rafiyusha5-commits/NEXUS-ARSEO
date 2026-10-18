// Read-only evidence; deliberately separate from invoice_items and the confirmation RPC.
export type CommodityLine = {
  number: number; sku: string | null; description: string; hsCode: string | null;
  quantity: number | null; unit: string | null; amount: number | null;
  grossKg: number | null; netKg: number | null; customsValue: number | null;
  warnings: string[];
};
export type CommodityInvoice = {
  number: string | null; currency: string | null; total: number | null;
  items: CommodityLine[]; warnings: string[];
};
export const INVOICE_LAYOUT_MARKER = "\n--- INVOICE TABLE LAYOUT ---\n";
export const isBilingualInvoice = (text: string) => /FAKTURA VAT\s*\/\s*INVOICE/iu.test(text) && /Kod EAN/iu.test(text);
const decimal = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const clean = value.trim();
  if (!/^(?:\d+|\d{1,3}(?:[ \u00a0]\d{3})+)(?:,\d{1,3})?$/u.test(clean)) return null;
  const n = Number(clean.replace(/[ \u00a0]/g, "").replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const blankLine = (number: number): CommodityLine => ({ number, sku: null, description: "", hsCode: null, quantity: null, unit: null, amount: null, grossKg: null, netKg: null, customsValue: null, warnings: [] });
export function commodityUnit(unit: string | null | undefined) {
  const value = (unit ?? "").trim().toLowerCase().replace(/\.$/u, "");
  if (/^(шт|штук|штука|штуки|piece|pieces|pcs|pc|sztuka|szt)$/u.test(value)) return "piece";
  if (/^(кг|kg)$/u.test(value)) return "kg";
  if (/^(кор|короб|коробка|box|boxes|carton|cartons)$/u.test(value)) return "box";
  return null;
}

export function parseDeclarationItems(raw: string) {
  const warnings: string[] = [];
  const items: CommodityLine[] = [];
  // Only numbered box 31/32/33 bodies, never the repeated list in appendices or blank third forms.
  for (const block of raw.split(/^31 Грузовые[^\n]*\n/mu).slice(1)) {
    const body = block.split(/\f|^47(?:\s|$)/mu)[0];
    const id = body.match(/^\s*(\d+)\s*\|\s*(\d{10})(?:\s*\||\s*$)/mu);
    if (!id) continue;
    const item = blankLine(Number(id[1]));
    item.hsCode = id[2];
    const description = body.match(/^1\.\s+([\s\S]*?)(?=^FI\s*\||^[A-Z]{2}\s*\||^38 Вес|^37 ПРОЦЕДУРА)/mu)?.[1] ?? "";
    item.description = description.replace(/\|[^\n]*/gu, "").replace(/^(?:товаров|[ОO0]{4}[A-Z][ОO0]{2})\s*$/gmu, "").replace(/\s+/gu, " ").trim().replace(/,$/u, "");
    item.grossKg = decimal(body.match(/^[A-Z]{2}\s*\|\s*(?:\|\s*)?([\d ,]+)(?:\||$)/mu)?.[1]);
    item.netKg = decimal(body.match(/^\d{4}\s*\|\s*\d{3}\s*\|\s*([\d ,]+)$/mu)?.[1]);
    const priceBox = body.split("42 Цена товара")[1]?.split("45 Таможенная стоимость")[0] ?? "";
    item.amount = decimal(priceBox.match(/\|\s*(\d[\d ]*,\d{2})\s*\|\s*\d\s*$/mu)?.[1]);
    const valueBox = body.split("45 Таможенная стоимость")[1]?.split("46 Статистическая стоимость")[0] ?? "";
    item.customsValue = decimal(valueBox.match(/^\s*(?:\|\s*)?(\d[\d ]*,\d{2})\s*$/mu)?.[1]);
    items.push(item);
  }
  const appendix = raw.split("Графа 31 Описание товара")[1]?.split("Графа 44")[0] ?? "";
  const descriptions = [...appendix.matchAll(/^(\d+)\s*\|\s*1\.\s+([\s\S]*?)(?=^\d+\s*\|\s*1\.|$(?![\s\S]))/gmu)];
  for (const item of items) {
    const matches = descriptions.filter(m => Number(m[1]) === item.number);
    if (matches.length === 1) {
      const text = matches[0][2].replace(/\s+/gu, " ");
      const skus = [...text.matchAll(/АРТИКУЛ:\s*([A-ZА-Я0-9][A-ZА-Я0-9._/-]*)/giu)];
      const quantities = [...text.matchAll(/ОБЩЕЕ КОЛИЧЕСТВО В ЕД\. ФИЗ\. ОБЪЕМА:\s*(\d[\d ]*(?:,\d{1,3})?)\s+([А-ЯA-Z.]+)/giu)];
      if (skus.length === 1) item.sku = skus[0][1];
      if (quantities.length === 1) { item.quantity = decimal(quantities[0][1]); item.unit = quantities[0][2]; }
    }
    if (matches.length !== 1 || !item.sku || item.quantity === null || !commodityUnit(item.unit)) item.warnings.push("Артикул или количество из приложения не определены однозначно.");
    if (item.amount === null || item.netKg === null || item.grossKg === null || item.customsValue === null) item.warnings.push("Часть граф строки не прочитана; проверьте оригинал.");
    if (items.filter(other => other.number === item.number).length !== 1) item.warnings.push("Номер товарной строки повторяется.");
  }
  const countMatch = raw.split("\f")[0].match(/5 Всего т-ов[^\n]*\n\s*(\d+)\s*\|/u);
  const expectedCount = countMatch ? Number(countMatch[1]) : null;
  if (expectedCount === null || items.length !== expectedCount || items.some((item, index) => item.number !== index + 1)) warnings.push("Полнота товарных строк не подтверждена графой 5.");
  if (items.some(item => item.warnings.length)) warnings.push("Есть строки, требующие проверки по оригиналу.");
  return { items, expectedCount, warnings };
}

export function parseCommodityInvoice(raw: string): CommodityInvoice | null {
  if (!isBilingualInvoice(raw)) return null;
  const layout = raw.split(INVOICE_LAYOUT_MARKER)[1];
  if (!layout) return null;
  const totalMatch = layout.match(/Total \(Razem\) ([A-Z]{3}):\s*\|\s*([\d ,]+)\s*\|/u);
  const result: CommodityInvoice = {
    number: layout.match(/INVOICE NO\):\s*\|\s*([A-Z0-9/_.-]+)/iu)?.[1] ?? null,
    currency: totalMatch?.[1] ?? null, total: decimal(totalMatch?.[2]), items: [], warnings: [],
  };
  const table = layout.split("LP.")[1]?.split("Total (Razem)")[0] ?? "";
  let candidateCount = 0;
  for (const row of table.split(/\r?\n/u)) {
    const columns = row.split("|").map(cell => cell.trim());
    if (!/^\d+$/u.test(columns[0]) || !/^[A-Z0-9][A-Z0-9._/-]*$/u.test(columns[1] ?? "")) continue;
    candidateCount++;
    const ean = columns.findIndex((cell, index) => index >= 3 && /^\d{13}$/u.test(cell));
    if (ean < 0 || columns.length !== ean + 8) { result.warnings.push("Не все колонки строки инвойса прочитаны."); continue; }
    const item = blankLine(Number(columns[0]));
    item.sku = columns[1]; item.description = columns.slice(2, ean - 1).join(" ");
    item.unit = columns[ean + 1]; item.quantity = decimal(columns[ean + 2]);
    const unitPrice = decimal(columns[ean + 3]);
    item.amount = decimal(columns[ean + 4]);
    if (item.quantity === null || item.amount === null || unitPrice === null || Math.abs(item.quantity * unitPrice - item.amount) > 0.011) item.warnings.push("Количество × цена не подтверждает сумму строки.");
    result.items.push(item);
  }
  if (!result.items.length || candidateCount !== result.items.length || result.items.some((item, index) => item.number !== index + 1)) result.warnings.push("Нумерация или полнота строк инвойса не подтверждена.");
  if (result.total === null || result.items.some(item => item.amount === null || item.warnings.length) || Math.abs(result.items.reduce((sum, item) => sum + (item.amount ?? 0), 0) - result.total) > 0.011) result.warnings.push("Сумма строк не подтверждает итог инвойса.");
  return result;
}

export type ShipmentCommodity = { sku: string | null; unit: string; ordered: number | null; confirmed: number | null; shipped: number | null; hsCode: string | null };
export function isCommodityLine(value: unknown): value is CommodityLine {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.number) && Number(v.number) > 0 && typeof v.description === "string"
    && ["sku", "hsCode", "unit"].every(key => v[key] === null || typeof v[key] === "string")
    && ["quantity", "amount", "grossKg", "netKg", "customsValue"].every(key => v[key] === null || typeof v[key] === "number" && Number.isFinite(v[key]) && Number(v[key]) >= 0)
    && Array.isArray(v.warnings) && v.warnings.every(w => typeof w === "string");
}
export function isCommodityInvoice(value: unknown): value is CommodityInvoice {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return ["number", "currency"].every(key => v[key] === null || typeof v[key] === "string")
    && (v.total === null || typeof v.total === "number" && Number.isFinite(v.total))
    && Array.isArray(v.items) && v.items.every(isCommodityLine) && Array.isArray(v.warnings) && v.warnings.every(w => typeof w === "string");
}
export function currentCommoditySource(source: { status: string; document_version_id: string; shipment_transport_id?: string | null }, document: {
  archived_at: string | null; status: string; current_version: number; versions: Array<{ id: string; is_current: boolean; version_number: number }>;
  links: Array<{ entity_type: string; entity_id: string; removed_at: string | null }>;
} | null | undefined, shipmentId: string, transportIds: string[]) {
  return Boolean(document && !document.archived_at && document.status !== "rejected"
    && (!source.shipment_transport_id || transportIds.includes(source.shipment_transport_id))
    && ["extracted", "needs_review", "confirmed"].includes(source.status)
    && document.versions?.filter(v => v.is_current).length === 1
    && document.versions.some(v => v.is_current && v.id === source.document_version_id && v.version_number === document.current_version)
    && document.links?.some(link => !link.removed_at && (link.entity_type === "shipment" && link.entity_id === shipmentId || link.entity_type === "shipment_transport" && transportIds.includes(link.entity_id))));
}
export type CommodityComparison = { line: CommodityLine; invoice: string; shipment: string; invoiceMatched: boolean; orderedMatched: boolean; status: "matched" | "different" | "review" };
export function compareCommodities(items: CommodityLine[], currency: string | null, invoices: CommodityInvoice[], shipment: ShipmentCommodity[]): CommodityComparison[] {
  return items.map(line => {
    let status: CommodityComparison["status"] = line.warnings.length ? "review" : "matched";
    let invoiceMatched = false, orderedMatched = false;
    const review = () => { if (status !== "different") status = "review"; };
    let invoice = "Нет однозначного инвойса для сверки";
    const inv = invoices.length === 1 ? invoices[0] : null;
    const duplicate = !line.sku || items.filter(item => item.sku === line.sku).length !== 1;
    const candidates = inv?.items.filter(item => item.sku === line.sku) ?? [];
    if (duplicate || candidates.length !== 1 || !inv) review();
    else {
      const other = candidates[0];
      if (inv.warnings.length || other.warnings.length || !commodityUnit(line.unit) || commodityUnit(line.unit) !== commodityUnit(other.unit) || !currency || currency !== inv.currency || line.quantity === null || other.quantity === null || line.amount === null || other.amount === null) {
        invoice = "Нужна проверка единиц, валюты или полноты инвойса"; review();
      } else if (Math.abs(line.quantity - other.quantity) > 0.000001 || Math.abs(line.amount - other.amount) > 0.011) {
        invoice = `Расхождение: в инвойсе ${other.quantity} ${other.unit}, ${other.amount} ${inv.currency}`; status = "different";
      } else { invoice = `Артикул, количество и сумма совпадают (${inv.number ?? "инвойс"})`; invoiceMatched = true; }
    }
    const positions = shipment.filter(item => item.sku === line.sku);
    let shipmentText = "Позиция поставки не найдена однозначно";
    if (duplicate || !positions.length) review();
    else if (!commodityUnit(line.unit) || positions.some(item => commodityUnit(item.unit) !== commodityUnit(line.unit)) || line.quantity === null) { shipmentText = "Разные или неизвестные единицы: нужен пересчёт"; review(); }
    else {
      const parts: string[] = [];
      for (const [field, label] of [["ordered", "Заказано"], ["confirmed", "Подтверждено"], ["shipped", "Отгружено"]] as const) {
        if (positions.some(item => item[field] === null)) { parts.push(`${label}: не заполнено`); review(); continue; }
        const sum = positions.reduce((total, item) => total + item[field]!, 0);
        const equal = Math.abs(sum - line.quantity) < 0.000001;
        if (field === "ordered") orderedMatched = equal;
        parts.push(`${label}: ${sum}${equal ? " — совпадает" : " — расхождение"}`);
        if (!equal) status = "different";
      }
      if (positions.some(item => item.hsCode && item.hsCode !== line.hsCode)) { parts.push("ТН ВЭД отличается от карточки товара"); status = "different"; }
      shipmentText = parts.join("; ");
    }
    return { line, invoice, shipment: shipmentText, invoiceMatched, orderedMatched, status };
  });
}
