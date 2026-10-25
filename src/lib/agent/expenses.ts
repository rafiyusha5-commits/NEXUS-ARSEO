import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
export const EXPENSE_TYPES = { goods_cost: "Стоимость товара", transport: "Перевозка", logistics: "Логистика", broker_fee: "Брокер", customs_duty: "Пошлина", tax: "НДС", stickering: "Стикеровка", marking: "Маркировка", bank_fee: "Банк", promo: "Промо", return: "Возврат", other: "Прочее" };
const params = {
 shipment_id: { type: "uuid", description: "Точная поставка из поиска" },
 expense_type: { type: "enum", values: Object.keys(EXPENSE_TYPES), description: "Выбранный сотрудником вид расхода" },
 payee_counterparty_id: { type: "uuid", optional: true, description: "Получатель из справочника или явно не указан" },
 amount: { type: "string", maxLength: 15, pattern: /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/, description: "Положительная сумма, до двух знаков, без округления" },
 currency_id: { type: "uuid", description: "Явная валюта из справочника" },
 incurred_at: { type: "date", description: "Дата расхода со слов сотрудника" },
 amount_kind: { type: "enum", values: ["actual", "planned"], description: "Факт или план, явно выбранные сотрудником" },
 document_id: { type: "uuid", optional: true, description: "Доступный зарегистрированный документ этой поставки или явно без документа" },
 notes: { type: "string", maxLength: 500, optional: true, description: "Примечание сотрудника или явно без примечания" },
} satisfies Record<string, ParamSchema>;
export const expenseSchema = { type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
 kind: { type: "string", enum: ["expense_create"] }, params: toJsonSchema(params),
} };
export function parseExpense(input: unknown) {
 if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(params).some(k => !Object.hasOwn(input,k))) return null;
 const raw = input as Record<string, unknown>;
 if (["payee_counterparty_id","document_id","notes"].some(k => raw[k] !== null && (typeof raw[k] !== "string" || !raw[k].trim()))) return null;
 const p = validateParams(params,input);
 if (!p.ok || Number(p.value.amount) <= 0) return null;
 return { ...p.value, payee_counterparty_id: p.value.payee_counterparty_id ?? null, document_id: p.value.document_id ?? null, notes: p.value.notes ?? null };
}

