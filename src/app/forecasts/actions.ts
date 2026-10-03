"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PublicError, publicErrorMessage } from "@/lib/errors/public-message";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function val(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value.trim():"";}
function uid(data:FormData,key:string,required=true){const value=val(data,key);if(!value&&!required)return null;if(!UUID.test(value))throw new PublicError(`Проверьте поле ${key}`);return value;}
function amount(data:FormData,key:string){const value=Number(val(data,key));if(!Number.isFinite(value)||value<0)throw new PublicError(`Проверьте поле ${key}`);return value;}
function message(error:unknown){return publicErrorMessage(error);}
function target(id:string|null,kind:"success"|"error",text:string){return `/forecasts?${id?`forecast=${id}&`:""}${kind}=${encodeURIComponent(text)}`;}

export async function createForecast(data:FormData){
 let created:string|null=null;
 try{const{supabase}=await requireUser();const{data:id,error}=await supabase.rpc("create_forecast",{p_name:val(data,"name"),p_scenario:val(data,"scenario"),p_horizon_start:val(data,"horizon_start"),p_horizon_end:val(data,"horizon_end"),p_granularity:val(data,"granularity"),p_method:"manual"});if(error)throw error;created=id as string;}
 catch(error){redirect(target(null,"error",message(error)));}
 revalidatePath("/forecasts");redirect(target(created,"success","Черновик прогноза создан"));
}

export async function saveForecastLine(data:FormData){const forecast=uid(data,"p_forecast_id") as string;
 try{const{supabase}=await requireUser();const{error}=await supabase.rpc("upsert_forecast_line",{p_forecast_id:forecast,p_product_id:uid(data,"p_product_id"),p_customer_id:uid(data,"p_customer_id",false),p_warehouse_id:uid(data,"p_warehouse_id",false),p_period_start:val(data,"p_period_start"),p_base_quantity:amount(data,"p_base_quantity"),p_promo_uplift_quantity:amount(data,"p_promo_uplift_quantity"),p_comment:val(data,"p_comment")||null});if(error)throw error;}
 catch(error){redirect(target(forecast,"error",message(error)));}
 revalidatePath("/forecasts");redirect(target(forecast,"success","Строка прогноза сохранена"));
}

async function rpcAction(data:FormData,name:string,args:Record<string,unknown>,success:string){const forecast=uid(data,"p_forecast_id") as string;
 try{const{supabase}=await requireUser();const{error}=await supabase.rpc(name,args);if(error)throw error;}
 catch(error){redirect(target(forecast,"error",message(error)));}
 revalidatePath("/forecasts");redirect(target(forecast,"success",success));
}
export async function removeForecastLine(data:FormData){return rpcAction(data,"remove_forecast_line",{p_line_id:uid(data,"p_line_id")},"Строка удалена");}
export async function submitForecast(data:FormData){return rpcAction(data,"submit_forecast",{p_forecast_id:uid(data,"p_forecast_id")},"Прогноз отправлен на проверку");}
export async function reviewForecast(data:FormData){return rpcAction(data,"review_forecast",{p_forecast_id:uid(data,"p_forecast_id"),p_approve:val(data,"decision")==="approve",p_comment:val(data,"comment")||null},val(data,"decision")==="approve"?"Коммерческая проверка завершена":"Прогноз возвращён в черновик");}
export async function approveForecast(data:FormData){return rpcAction(data,"approve_forecast",{p_forecast_id:uid(data,"p_forecast_id")},"Версия прогноза утверждена");}
export async function archiveForecast(data:FormData){return rpcAction(data,"archive_forecast",{p_forecast_id:uid(data,"p_forecast_id")},"Версия перемещена в архив");}
export async function createForecastVersion(data:FormData){const source=uid(data,"p_forecast_id") as string;let created:string|null=null;
 try{const{supabase}=await requireUser();const{data:id,error}=await supabase.rpc("create_forecast_version",{p_source_id:source});if(error)throw error;created=id as string;}
 catch(error){redirect(target(source,"error",message(error)));}
 revalidatePath("/forecasts");redirect(target(created,"success","Создан черновик новой версии"));
}
