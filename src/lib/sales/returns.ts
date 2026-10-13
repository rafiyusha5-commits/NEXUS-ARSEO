// Returns from customers (202609277500): labels and the return form.

export const RETURN_REASONS: Record<string, string> = {
  defect: "Брак", damaged: "Повреждение", expiry: "Срок годности", wrong_item: "Пересорт", refused: "Отказ клиента", other: "Другое",
};
export const RETURN_DECISIONS: Record<string, string> = {
  restock: "Вернуть в продажу", write_off: "Списать", return_to_supplier: "Вернуть поставщику",
};
export const RETURN_STATUS: Record<string, string> = { quarantine: "В карантине", closed: "Решения приняты", cancelled: "Отменён" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUANTITY = /^\d+(\.\d{1,3})?$/;

/** Form fields "qty_<sale item>_<batch>" and "reason_<sale item>_<batch>" → lines of create_customer_return. Empty quantities are skipped. */
export function parseReturnLines(entries: Iterable<[string, unknown]>) {
  const values = new Map<string, string>();
  for (const [key, raw] of entries) if (typeof raw === "string") values.set(key, raw.trim());
  const lines: Array<{ sale_item_id: string; batch_id: string; quantity: number; reason_code: string }> = [];
  for (const [key, value] of values) {
    if (!key.startsWith("qty_") || !value) continue;
    const [itemId, batchId] = key.slice(4).split("_");
    if (!UUID.test(itemId ?? "") || !UUID.test(batchId ?? "")) throw new Error("Некорректная позиция возврата");
    const text = value.replace(/\s/g, "").replace(",", ".");
    if (!QUANTITY.test(text) || Number(text) <= 0) throw new Error("Количество должно быть больше нуля, не более трёх знаков после запятой");
    const reason = values.get(`reason_${itemId}_${batchId}`) || "other";
    if (!(reason in RETURN_REASONS)) throw new Error("Некорректная причина возврата");
    lines.push({ sale_item_id: itemId, batch_id: batchId, quantity: Number(text), reason_code: reason });
  }
  return lines;
}
