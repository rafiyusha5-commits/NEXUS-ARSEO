// What scan_lookup (202611280500) returns, and its wording. Rendering only.

export type StockRow = {
  balance_id: string; warehouse_id: string; warehouse: string; location_id: string | null; location: string | null; product_id: string;
  sku: string; product: string; batch_id: string; batch: string; expiry_date: string | null; batch_status: string; uom: string;
  on_hand: string; reserved: string; free: string; unit_cost: string | null; cost_currency: string | null; cost_uom: string | null;
};
export type ScanProduct = { product_id: string; sku: string; product: string; identifier_type: string; uom: string; pieces: string | null;
  stock: StockRow[]; batch_found: boolean | null };
export type ScanResult =
  | { kind: "product"; code: string; products: ScanProduct[] }
  | { kind: "location"; code: string; location: { id: string; code: string; zone: string; status: string; warehouse_id: string; warehouse: string }; stock: StockRow[] }
  | { kind: "batch"; code: string; batch: { id: string; batch: string; expiry_date: string | null; status: string; product_id: string; sku: string; product: string }; stock: StockRow[] }
  | { kind: "unknown"; code: string; can_bind: boolean };

export const viaLabel: Record<string, string> = { scanner: "сканер", manual: "ввод вручную", camera: "камера" };
export const uomName: Record<string, string> = { piece: "штука", box: "коробка", layer: "слой", pallet: "паллета", truck: "машина" };

export function quantity(value: string | number | null | undefined) {
  return value == null ? "—" : Number(value).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
}
export function shortDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`)) : "—";
}
/** Days to the expiry, for "истекает через N дн." */
export function daysLeft(expiry: string | null, today: string) {
  if (!expiry) return null;
  return Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}
