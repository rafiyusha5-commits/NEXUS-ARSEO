import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
export const ALLOCATION_METHODS = { by_quantity: "По количеству", by_weight: "По весу", by_volume: "По объёму", by_value: "По стоимости" };
const params = { expense_id: { type: "uuid", description: "Точный фактический расход из реестра" }, method: { type: "enum", values: Object.keys(ALLOCATION_METHODS), description: "Способ, выбранный сотрудником" }, target_currency_id: { type: "uuid", description: "Явная валюта распределения из справочника" } } satisfies Record<string, ParamSchema>;
export const allocationSchema = { type: "object", additionalProperties: false, required: ["kind","params"], properties: {kind:{type:"string",enum:["expense_allocate"]},params:toJsonSchema(params)} };
export function parseAllocation(input:unknown){const p=validateParams(params,input);return p.ok?p.value:null;}
