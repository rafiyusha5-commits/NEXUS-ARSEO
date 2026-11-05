import { PublicError } from "../errors/public-message.ts";

export const allocationUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function allocationMoney(value: string): string {
  const clean = value.trim().replace(/[,]/g, ".");
  if (!/^(0|[1-9][0-9]{0,11})(\.[0-9]{1,2})?$/.test(clean)) throw new PublicError("Введите сумму без разделителей тысяч, с точностью до сотых.");
  const [whole, fraction = ""] = clean.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
}
export function allocationCents(value: string): bigint {
  return BigInt(allocationMoney(value).replace(".", ""));
}
export function parseExactAllocation(form: FormData) {
  function text(key: string) { const v = form.get(key); return typeof v === "string" ? v.trim() : ""; }
  function uuid(key: string, optional = false) { const v = text(key); if (optional && !v) return null; if (!allocationUuid.test(v)) throw new PublicError("Откройте распределение заново."); return v; }
  const ids = form.getAll("item_id"), amounts = form.getAll("amount");
  if (!ids.length || ids.length > 200 || ids.length !== amounts.length) throw new PublicError("Проверьте список товаров.");
  const seen = new Set<string>();
  const lines = ids.map((id, i) => {
    if (typeof id !== "string" || !allocationUuid.test(id) || seen.has(id.toLowerCase())) throw new PublicError("Товарные строки должны быть уникальными.");
    seen.add(id.toLowerCase());
    if (typeof amounts[i] !== "string") throw new PublicError("Проверьте суммы.");
    return { item_id: id, amount: allocationMoney(amounts[i] as string) };
  });
  const stamp = text("stamp"), note = text("basis_note");
  if (!/^[0-9a-f]{64}$/.test(stamp)) throw new PublicError("Откройте распределение заново.");
  if (note.length < 10 || note.length > 2000) throw new PublicError("Укажите источник и основание распределения (10–2000 символов).");
  return { p_request_id: uuid("request_id"), p_expense_id: uuid("expense_id"), p_currency_id: uuid("currency_id"), p_source_document_id: uuid("source_document_id", true), p_expected_stamp: stamp, p_lines: lines, p_basis_note: note };
}

export type ExactAllocationContext = {
  expense_id: string; shipment_id: string; shipment_number: string; expense_type: string;
  amount: string; currency: string; notes: string | null; status: string;
  target_currency_id: string; target_currency: string; total: string; stamp: string;
  source_document_id: string | null; source_title: string | null; source_version: number | null;
  sources: { id: string; title: string; current_version: number }[];
  lines: { item_id: string; sku: string; name: string; quantity: string; uom: string }[];
  previous: { shipment_item_id: string; allocated_amount: string | number; currency_id: string }[];
  history: { id: string; at: string; author: string; basis_note: string; currency: string; source_document_id: string | null; source_version: number | null; lines: { item_id: string; sku: string; amount: string }[] }[];
};
