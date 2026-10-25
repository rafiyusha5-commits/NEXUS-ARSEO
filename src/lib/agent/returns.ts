import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";

export const RETURN_REASONS = { defect: "Брак", damaged: "Повреждение", expiry: "Срок годности", wrong_item: "Пересорт", refused: "Отказ покупателя", other: "Другое" };
const header = {
 sale_id: { type: "uuid", description: "Точный отгруженный заказ" },
 reason: { type: "string", maxLength: 500, description: "Явная причина со слов сотрудника" },
} satisfies Record<string, ParamSchema>;
const line = {
 sale_item_id: { type: "uuid", description: "Позиция отгруженного заказа" },
 batch_id: { type: "uuid", description: "Отгруженная партия из get_return_options" },
 quantity: { type: "string", maxLength: 13, pattern: /^(?:0|[1-9]\d{0,8})(?:\.\d{1,3})?$/, description: "Количество пользователя в единице заказа" },
 reason_code: { type: "enum", values: Object.keys(RETURN_REASONS), description: "Причина возврата" },
} satisfies Record<string, ParamSchema>;
export const returnSchema = {
 type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
  kind: { type: "string", enum: ["customer_return_create"] },
  params: { ...toJsonSchema(header), required: [...Object.keys(header), "lines"], properties: {
   ...(toJsonSchema(header).properties as object), lines: { type: "array", minItems: 1, maxItems: 20, items: toJsonSchema(line) },
  } },
 },
};
export function parseReturn(input: unknown) {
 if (!input || typeof input !== "object" || Array.isArray(input)) return null;
 const { lines, ...rest } = input as Record<string, unknown>;
 const parsed = validateParams(header, rest);
 if (!parsed.ok || !String(parsed.value.reason).trim() || !Array.isArray(lines) || lines.length < 1 || lines.length > 20) return null;
 const seen = new Set<string>();
 const result: Record<string, string | number>[] = [];
 for (const raw of lines) {
  const p = validateParams(line, raw);
  if (!p.ok || Number(p.value.quantity) <= 0) return null;
  const key = `${p.value.sale_item_id}:${p.value.batch_id}`.toLowerCase();
  if (seen.has(key)) return null;
  seen.add(key); result.push(p.value);
 }
 return { ...parsed.value, lines: result };
}
