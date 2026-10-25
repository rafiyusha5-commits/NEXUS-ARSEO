import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
const params = {
 expense_id: { type: "uuid", description: "Точный оплаченный расход из доступного реестра" },
 reason: { type: "string", maxLength: 500, description: "Явная причина сторнирования со слов сотрудника" },
} satisfies Record<string, ParamSchema>;
export const expenseReversalSchema = { type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
 kind: { type: "string", enum: ["expense_reverse"] }, params: toJsonSchema(params),
} };
export function parseExpenseReversal(input: unknown) {
 const parsed = validateParams(params, input);
 return parsed.ok ? parsed.value : null;
}
