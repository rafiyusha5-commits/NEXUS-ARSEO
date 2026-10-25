import {validateParams,toJsonSchema} from "./schema.ts";
import type {ParamSchema} from "./types.ts";
const params={calculation_id:{type:"uuid",description:"Точная выбранная черновая версия себестоимости из реестра"}} satisfies Record<string,ParamSchema>;
export const costApprovalSchema={type:"object",additionalProperties:false,required:["kind","params"],properties:{kind:{type:"string",enum:["shipment_cost_approve"]},params:toJsonSchema(params)}};
export function parseCostApproval(input:unknown){const p=validateParams(params,input);return p.ok?p.value:null;}
