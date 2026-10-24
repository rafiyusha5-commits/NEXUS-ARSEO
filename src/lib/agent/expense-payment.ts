import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
const params = { expense_id: { type: "uuid", description: "Точный фактический распределённый расход для фиксации полной оплаты" } } satisfies Record<string, ParamSchema>;
export const expensePaymentSchema = { type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
 kind: { type: "string", enum: ["expense_mark_paid"] }, params: toJsonSchema(params),
} };
export function parseExpensePayment(input: unknown) {
 const parsed = validateParams(params, input);
 return parsed.ok ? parsed.value : null;
}
