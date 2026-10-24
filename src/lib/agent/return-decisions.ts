import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
export const RETURN_DECISIONS = { restock: "Вернуть в продажу", write_off: "Списать", return_to_supplier: "Вернуть поставщику" };
const params = {
 item_id: { type: "uuid", description: "Точная позиция возврата из get_return_decisions" },
 decision: { type: "enum", values: Object.keys(RETURN_DECISIONS), description: "Явно выбранное сотрудником решение" },
 location_id: { type: "uuid", optional: true, description: "Зона исходного склада или явно без зоны; для списания/поставщика только null" },
 note: { type: "string", maxLength: 500, optional: true, description: "Причина/комментарий сотрудника; для списания/поставщика обязательна" },
} satisfies Record<string, ParamSchema>;
export const returnDecisionSchema = { type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
 kind: { type: "string", enum: ["customer_return_decide"] }, params: toJsonSchema(params),
} };
export function parseReturnDecision(input: unknown) {
 if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(params).some(k => !Object.hasOwn(input, k))) return null;
 const raw = input as Record<string, unknown>;
 if (["location_id", "note"].some(k => raw[k] !== null && (typeof raw[k] !== "string" || !raw[k].trim()))) return null;
 const p = validateParams(params, input);
 if (!p.ok || (p.value.decision !== "restock" && (!p.value.note || raw.location_id !== null))) return null;
 return { ...p.value, location_id: p.value.location_id ?? null, note: p.value.note ?? null };
}
