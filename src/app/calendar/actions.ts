"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PublicError, publicErrorMessage } from "@/lib/errors/public-message";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function value(data:FormData,key:string){const raw=data.get(key);return typeof raw==="string"?raw.trim():"";}
function uuid(data:FormData,key:string,required=true){const result=value(data,key);if(!result&&!required)return null;if(!UUID.test(result))throw new PublicError(`Проверьте поле ${key}`);return result;}
function location(data:FormData){const month=value(data,"month");return `/calendar${/^\d{4}-\d{2}$/.test(month)?`?month=${month}`:""}`;}
function message(error:unknown){return publicErrorMessage(error);}

export async function createMilestone(data:FormData){const back=location(data);
 try{const{supabase}=await requireUser();const kind=value(data,"kind");if(!["document","customs","payment","inspection","other"].includes(kind))throw new PublicError("Выберите тип контрольной точки");
  const planned=value(data,"planned_at");if(!planned)throw new PublicError("Укажите плановую дату");
  const{error}=await supabase.rpc("create_shipment_milestone",{p_shipment_id:uuid(data,"shipment_id"),p_title:value(data,"title"),p_kind:kind,p_planned_at:new Date(planned).toISOString(),p_responsible_user_id:uuid(data,"responsible_user_id",false),p_notes:value(data,"notes")||null});if(error)throw error;
 }catch(error){redirect(`${back}${back.includes("?")?"&":"?"}error=${encodeURIComponent(message(error))}`);}
 revalidatePath("/calendar");revalidatePath("/");redirect(`${back}${back.includes("?")?"&":"?"}success=${encodeURIComponent("Контрольная точка добавлена")}`);
}

export async function completeMilestone(data:FormData){const back=location(data);
 try{const{supabase}=await requireUser();const actual=value(data,"actual_at");const{error}=await supabase.rpc("complete_shipment_milestone",{p_milestone_id:uuid(data,"milestone_id"),p_actual_at:actual?new Date(actual).toISOString():new Date().toISOString()});if(error)throw error;}
 catch(error){redirect(`${back}${back.includes("?")?"&":"?"}error=${encodeURIComponent(message(error))}`);}
 revalidatePath("/calendar");revalidatePath("/");redirect(`${back}${back.includes("?")?"&":"?"}success=${encodeURIComponent("Фактическая дата зафиксирована")}`);
}

export async function cancelMilestone(data:FormData){const back=location(data);
 try{const{supabase}=await requireUser();const{error}=await supabase.rpc("cancel_shipment_milestone",{p_milestone_id:uuid(data,"milestone_id")});if(error)throw error;}
 catch(error){redirect(`${back}${back.includes("?")?"&":"?"}error=${encodeURIComponent(message(error))}`);}
 revalidatePath("/calendar");revalidatePath("/");redirect(`${back}${back.includes("?")?"&":"?"}success=${encodeURIComponent("Контрольная точка отменена")}`);
}
