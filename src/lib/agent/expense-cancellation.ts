import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
const params = {
 expense_id: { type: "uuid", description: "Точный неоплаченный расход из доступного реестра" },
 reason: { type: "string", maxLength: 500, description: "Явная причина отмены со слов сотрудника" },
} satisfies Record<string, ParamSchema>;
export const expenseCancellationSchema = { type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
 kind: { type: "string", enum: ["expense_cancel"] }, params: toJsonSchema(params),
} };
export function parseExpenseCancellation(input: unknown) {
 const parsed = validateParams(params, input);
 return parsed.ok ? parsed.value : null;
}
