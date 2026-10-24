import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
const params = {
 return_id: { type: "uuid", description: "Точный возврат из get_return_cancellations" },
 reason: { type: "string", maxLength: 500, description: "Явная причина отмены со слов сотрудника" },
} satisfies Record<string, ParamSchema>;
export const returnCancellationSchema = { type: "object", additionalProperties: false, required: ["kind", "params"], properties: {
 kind: { type: "string", enum: ["customer_return_cancel"] }, params: toJsonSchema(params),
} };
export function parseReturnCancellation(input: unknown) {
 const parsed = validateParams(params, input);
 return parsed.ok ? parsed.value : null;
}

