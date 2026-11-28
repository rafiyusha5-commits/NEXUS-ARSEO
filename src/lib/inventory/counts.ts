// Inventory counts (202611280300): types, labels and the rows of the XLSX report. The database decides what each
// employee sees: the book quantity of a blind count is never in the sheet, money only with purchase prices.
import type { XlsxCell } from "../xlsx.ts";

export type CountStatus = "draft" | "counting" | "recount" | "review" | "posted" | "cancelled";
export type CountKind = "full" | "partial";
export type LineKind = "match" | "shortage" | "surplus" | "unknown_batch";

export type CountListRow = {
  id: string; number: string; status: CountStatus; kind: CountKind; blind: boolean; warehouse: string; responsible: string | null;
  created_at: string; started_at: string | null; posted_at: string | null; cancelled_at: string | null; entries: number;
};
export type CountList = { can_manage: boolean; can_settings: boolean; tolerance_pieces: string; counts: CountListRow[] };

export type CountEntry = {
  id: string; round: 1 | 2; location_id: string | null; location: string | null; product_id: string; sku: string; product: string;
  batch_id: string | null; batch: string | null; expiry_date: string | null; uom: string; quantity: string; note: string | null;
  counted_by: string | null; counted_at: string; supersedes_entry_id: string | null; superseded: boolean;
};
export type RecountItem = {
  location_id: string | null; location: string | null; product_id: string; sku: string; product: string; batch_id: string | null;
  batch: string | null; uom: string; done: boolean; first_counters: string[];
};
export type BookRow = {
  location_id: string | null; location: string | null; product_id: string; sku: string; product: string; batch_id: string;
  batch: string; expiry_date: string | null; uom: string; quantity: string;
};
export type CountSheet = {
  id: string; number: string; status: CountStatus; kind: CountKind; blind: boolean; note: string | null; warehouse_id: string;
  warehouse: string; responsible: string | null; created_at: string; started_at: string | null; review_at: string | null;
  posted_at: string | null; cancelled_at: string | null; cancellation_reason: string | null; tolerance_pieces: string;
  adjustment_document_id: string | null; adjustment_document: string | null; round: 1 | 2 | null;
  can_manage: boolean; can_record: boolean; can_approve: boolean;
  scope: Array<{ type: "location" | "no_location" | "product"; location_id: string | null; location: string | null; zone: string | null;
    product_id: string | null; sku: string | null; product: string | null }>;
  locations: Array<{ id: string; code: string; zone: string }>; no_location: boolean;
  entries: CountEntry[]; recount: RecountItem[] | null; book: BookRow[] | null;
};
export type CatalogProduct = { id: string; sku: string; product: string; uoms: string[]; batches: Array<{ id: string; batch: string; expiry_date: string | null }> };

export type ReviewLine = {
  id: string; location_id: string | null; location: string | null; product_id: string; sku: string; product: string;
  batch_id: string | null; batch: string | null; expiry_date: string | null; uom: string; book: string; reserved: string;
  counted: string; recount: string | null; final: string; difference: string; difference_pieces: string | null; kind: LineKind;
  other_location: boolean; needs_recount: boolean; reason_code: string | null; reason: string | null; pair_line_id: string | null;
  assigned_batch_id: string | null; assigned_batch: string | null; ignored: boolean; decided_by: string | null; decided_at: string | null;
  difference_kzt: string | null; problem: "reason" | "batch" | "reserved" | null;
  orders: Array<{ sale_id: string; sale_number: string }> | null; batches: Array<{ id: string; batch: string; expiry_date: string | null }> | null;
};
export type CountReview = {
  number: string; status: CountStatus; cost: boolean; can_approve: boolean; digest: string | null;
  totals: { lines: number; matches: number; shortages: number; surpluses: number; unknown: number; shortage_pieces: string;
    surplus_pieces: string; shortage_kzt: string | null; surplus_kzt: string | null; no_cost_lines: number | null; problems: number };
  lines: ReviewLine[];
  by_reason: Array<{ reason_code: string | null; reason: string | null; lines: number; pieces: string; kzt: string | null }>;
  by_location: Array<{ location_id: string | null; location: string | null; lines: number; shortage_pieces: string; surplus_pieces: string;
    shortage_kzt: string | null; surplus_kzt: string | null }>;
  reasons: Array<{ code: string; name: string }>;
};

export const countStatusLabel: Record<CountStatus, string> = {
  draft: "Черновик", counting: "Подсчёт", recount: "Повторный подсчёт", review: "На утверждении", posted: "Проведена", cancelled: "Отменена",
};
export const countKindLabel: Record<CountKind, string> = { full: "Весь склад", partial: "Часть склада" };
export const lineKindLabel: Record<LineKind, string> = { match: "Совпало", shortage: "Недостача", surplus: "Излишек", unknown_batch: "Партия не определена" };
export const uomLabel: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "палл.", truck: "машина" };
export const zoneLabel: Record<string, string> = {
  receiving: "Приёмка", storage: "Хранение", picking: "Отбор", quarantine: "Карантин", stickering: "Стикеровка", shipping: "Отгрузка",
};
export const problemLabel: Record<NonNullable<ReviewLine["problem"]>, string> = {
  reason: "нужна причина недостачи",
  batch: "выберите партию или «не учитывать»",
  reserved: "остаток станет меньше резерва заказов — сначала снимите или замените резерв",
};

export function countQuantity(value: string | number | null | undefined) {
  if (value == null) return "—";
  return Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}
export function countMoney(value: string | null | undefined) {
  if (value == null) return "—";
  return Number(value).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function countDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(value)) : "—";
}

/** Active records of the sheet summed per line (location, product, batch, unit) of a round: what was counted so far. */
export function countedTotals(entries: CountEntry[], round: 1 | 2) {
  const totals = new Map<string, { entry: CountEntry; quantity: number; records: number }>();
  for (const entry of entries) {
    if (entry.round !== round || entry.superseded) continue;
    const key = [entry.location_id ?? "", entry.product_id, entry.batch_id ?? "", entry.uom].join("|");
    const total = totals.get(key) ?? { entry, quantity: 0, records: 0 };
    total.quantity += Number(entry.quantity);
    total.records += 1;
    totals.set(key, total);
  }
  return [...totals.values()].sort((left, right) =>
    (left.entry.location ?? "").localeCompare(right.entry.location ?? "") || left.entry.sku.localeCompare(right.entry.sku));
}

/** The report of a reviewed count as XLSX rows: totals, lines, sums by reason and by location. Money only if given. */
export function reviewRows(sheet: Pick<CountSheet, "number" | "warehouse" | "status">, review: CountReview): XlsxCell[][] {
  const cost = review.cost;
  const rows: XlsxCell[][] = [
    [`Инвентаризация ${sheet.number}`, sheet.warehouse, countStatusLabel[sheet.status]],
    ["Строк", review.totals.lines, "совпало", review.totals.matches, "недостач", review.totals.shortages, "излишков", review.totals.surpluses,
      "партия не определена", review.totals.unknown],
    ["Недостача, шт.", Number(review.totals.shortage_pieces), "Излишек, шт.", Number(review.totals.surplus_pieces),
      ...(cost ? ["Недостача, KZT", num(review.totals.shortage_kzt), "Излишек, KZT", num(review.totals.surplus_kzt)] : [])],
  ];
  if (!cost) rows.push(["Без права на закупочные цены суммы в деньгах не показываются"]);
  rows.push([]);
  rows.push(["Место", "Артикул", "Товар", "Партия", "Срок годности", "Единица", "Учёт", "Подсчёт", "Повторный подсчёт", "Итог", "Разница",
    "Вид", "Причина", ...(cost ? ["Разница, KZT"] : [])]);
  for (const line of review.lines) {
    rows.push([line.location ?? "без зоны", line.sku, line.product, line.batch ?? (line.assigned_batch ? `не определена → ${line.assigned_batch}` : "не определена"),
      line.expiry_date ?? "", uomLabel[line.uom] ?? line.uom, Number(line.book), Number(line.counted), num(line.recount), Number(line.final),
      Number(line.difference), lineKindLabel[line.kind] + (line.other_location ? " (другое место)" : "") + (line.ignored ? " (не учитывается)" : ""),
      line.reason ?? "", ...(cost ? [num(line.difference_kzt)] : [])]);
  }
  rows.push([]);
  rows.push(["По причинам", "Строк", "Штук", ...(cost ? ["KZT"] : [])]);
  for (const reason of review.by_reason) {
    rows.push([reason.reason ?? (reason.reason_code === "surplus" ? "Излишек" : reason.reason_code === "unknown_batch" ? "Партия не определена" : "—"),
      reason.lines, Number(reason.pieces), ...(cost ? [num(reason.kzt)] : [])]);
  }
  rows.push([]);
  rows.push(["По местам", "Строк с разницей", "Недостача, шт.", "Излишек, шт.", ...(cost ? ["Недостача, KZT", "Излишек, KZT"] : [])]);
  for (const location of review.by_location) {
    rows.push([location.location ?? "без зоны", location.lines, Number(location.shortage_pieces), Number(location.surplus_pieces),
      ...(cost ? [num(location.shortage_kzt), num(location.surplus_kzt)] : [])]);
  }
  return rows;
}

const num = (value: string | null | undefined): XlsxCell => value == null ? null : Number(value);
