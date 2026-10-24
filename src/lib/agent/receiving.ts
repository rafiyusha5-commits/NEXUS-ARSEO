import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";

const quantity: ParamSchema = { type: "string", maxLength: 13, pattern: /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, description: "Явное количество в единице позиции, до 0,001" };
const header = {
  transport_id: { type: "uuid", description: "Точный прибывший автомобиль поставки" },
  location_id: { type: "uuid", optional: true, description: "Зона склада или явное отсутствие зоны" },
} satisfies Record<string, ParamSchema>;
const line = {
  item_id: { type: "uuid", description: "Позиция выбранного автомобиля" },
  accepted_quantity: quantity, damaged_quantity: quantity,
  batch_number: { type: "string", maxLength: 80, optional: true, description: "Номер партии с товара, не выдумывать" },
  manufacture_date: { type: "date", optional: true, description: "Дата производства или явно неизвестна" },
  expiry_date: { type: "date", optional: true, description: "Срок годности с товара" },
  discrepancy_reason: { type: "string", maxLength: 200, optional: true, description: "Причина расхождения со слов сотрудника, не предположение" },
} satisfies Record<string, ParamSchema>;
export const receivingSchema = {
  type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
    kind: { type: "string", enum: ["shipment_transport_receive"] },
    params: { ...toJsonSchema(header), required: [...Object.keys(header), "lines"], properties: {
      ...(toJsonSchema(header).properties as object),
      lines: { type: "array", minItems: 1, maxItems: 20, items: toJsonSchema(line) },
    } },
  },
};
export function parseReceiving(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { lines, ...rest } = input as Record<string, unknown>;
  if (!Object.hasOwn(rest, "location_id") || (rest.location_id !== null && (typeof rest.location_id !== "string" || !rest.location_id.trim()))) return null;
  const parsed = validateParams(header, rest);
  if (!parsed.ok || !Array.isArray(lines) || lines.length < 1 || lines.length > 20) return null;
  const seen = new Set<string>();
  const result: Record<string, string | number | null>[] = [];
  for (const raw of lines) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(line).some(key => !Object.hasOwn(raw, key))) return null;
    const p = validateParams(line, raw);
    if (!p.ok) return null;
    const id = String(p.value.item_id).toLowerCase();
    if (seen.has(id)) return null;
    seen.add(id);
    if (Number(p.value.accepted_quantity) > 0 && (!p.value.batch_number || !p.value.expiry_date)) return null;
    if (Number(p.value.damaged_quantity) > 0 && !p.value.discrepancy_reason) return null;
    if (p.value.manufacture_date && p.value.expiry_date && p.value.manufacture_date > p.value.expiry_date) return null;
    result.push(Object.fromEntries(Object.keys(line).map(key => [key, p.value[key] ?? null])));
  }
  return { ...parsed.value, location_id: parsed.value.location_id ?? null, lines: result };
}
