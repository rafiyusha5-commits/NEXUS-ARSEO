import { validateParams, toJsonSchema } from "./schema.ts";
import type { ParamSchema } from "./types.ts";
const params = {
 shipment_id: {type:"uuid",description:"Точная поставка из текущего поиска"},
 target_currency_id: {type:"uuid",description:"Явно выбранная валюта расчёта"},
} satisfies Record<string,ParamSchema>;
export const costSchema={type:"object",additionalProperties:false,required:["kind","params"],properties:{
 kind:{type:"string",enum:["shipment_cost_calculate"]},params:toJsonSchema(params)}};
export function parseCost(input:unknown){const p=validateParams(params,input);return p.ok?p.value:null;}
