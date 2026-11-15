"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import type {Kind,Row} from "@/lib/freight/model";

export async function saveDirectory(input:{kind:Kind;request:string;id:string|null;version:number;values:Row;reason:string}) {
  const {supabase}=await requireUser();
  const {data,error}=await supabase.rpc("save_freight_directory",{p_kind:input.kind,p_request:input.request,p_id:input.id,p_version:input.version,p_values:input.values,p_reason:input.reason});
  if(error)return {error:ruleViolationMessage(error,"Не удалось сохранить справочник. Обновите данные и повторите проверку.")};
  revalidatePath("/freight");return {id:String(data)};
}
export async function previewTrip(input:{mode:string;operations:string[];values:Row}) {
  const {supabase}=await requireUser();
  const {data,error}=await supabase.rpc("preview_freight_trip",{p_mode:input.mode,p_operations:input.operations,p_values:input.values});
  if(error)return {error:ruleViolationMessage(error,"Не удалось подготовить рейс.")};
  return {preview:data as {snapshot:Row;digest:string}};
}
export async function saveTrip(input:{request:string;id:string|null;version:number;mode:string;operations:string[];values:Row;digest:string;reason:string}) {
  const {supabase}=await requireUser();
  const {data,error}=await supabase.rpc("save_freight_trip",{p_request:input.request,p_id:input.id,p_version:input.version,p_mode:input.mode,p_operations:input.operations,p_values:input.values,p_preview_digest:input.digest,p_reason:input.reason});
  if(error)return {error:ruleViolationMessage(error,"Не удалось сохранить рейс. Повторите предпросмотр.")};
  revalidatePath("/freight");return {id:String(data)};
}
