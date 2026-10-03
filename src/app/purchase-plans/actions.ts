"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PublicError, publicErrorMessage } from "@/lib/errors/public-message";

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function val(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value.trim():"";}
function uid(data:FormData,key:string,required=true){const value=val(data,key);if(!value&&!required)return null;if(!UUID.test(value))throw new PublicError(`Проверьте поле ${key}`);return value;}
function num(data:FormData,key:string){const value=Number(val(data,key));if(!Number.isFinite(value)||value<0)throw new PublicError(`Проверьте поле ${key}`);return value;}
function message(error:unknown){return publicErrorMessage(error);}
function target(id:string|null,kind:"success"|"error",text:string){return `/purchase-plans?${id?`plan=${id}&`:""}${kind}=${encodeURIComponent(text)}`;}

export async function createPurchasePlan(data:FormData){let created:string|null=null;try{const{supabase}=await requireUser();const{data:id,error}=await supabase.rpc("create_purchase_plan",{p_name:val(data,"name"),p_forecast_id:uid(data,"forecast_id"),p_supplier_id:uid(data,"supplier_id")});if(error)throw error;created=id as string;}catch(error){redirect(target(null,"error",message(error)));}revalidatePath("/purchase-plans");redirect(target(created,"success","Черновик плана закупок создан"));}

export async function savePurchasePlanLine(data:FormData){const plan=uid(data,"p_plan_id") as string;try{const{supabase}=await requireUser();const{error}=await supabase.rpc("upsert_purchase_plan_line",{p_plan_id:plan,p_product_id:uid(data,"p_product_id"),p_stock_on_hand:num(data,"p_stock_on_hand"),p_stock_in_transit:num(data,"p_stock_in_transit"),p_stock_reserved:num(data,"p_stock_reserved"),p_safety_stock:num(data,"p_safety_stock"),p_expiring_before_sale:num(data,"p_expiring_before_sale"),p_suggested_quantity:num(data,"p_suggested_quantity"),p_rounding_uom:val(data,"p_rounding_uom"),p_pack_multiple:num(data,"p_pack_multiple"),p_approved_quantity:num(data,"p_approved_quantity"),p_planned_order_date:val(data,"p_planned_order_date")||null,p_comment:val(data,"p_comment")||null});if(error)throw error;}catch(error){redirect(target(plan,"error",message(error)));}revalidatePath("/purchase-plans");redirect(target(plan,"success","Строка плана сохранена"));}

async function rpcAction(data:FormData,name:string,args:Record<string,unknown>,success:string){const plan=uid(data,"p_plan_id") as string;try{const{supabase}=await requireUser();const{error}=await supabase.rpc(name,args);if(error)throw error;}catch(error){redirect(target(plan,"error",message(error)));}revalidatePath("/purchase-plans");redirect(target(plan,"success",success));}
export async function removePurchasePlanLine(data:FormData){return rpcAction(data,"remove_purchase_plan_line",{p_line_id:uid(data,"p_line_id")},"Строка удалена");}
export async function submitPurchasePlan(data:FormData){return rpcAction(data,"submit_purchase_plan",{p_plan_id:uid(data,"p_plan_id")},"План отправлен на логистическую проверку");}
export async function reviewPurchasePlan(data:FormData){const decision=val(data,"decision");return rpcAction(data,"review_purchase_plan",{p_plan_id:uid(data,"p_plan_id"),p_approve:decision==="approve",p_comment:val(data,"comment")||null},decision==="approve"?"Логистическая проверка завершена":"План возвращён в черновик");}
export async function approvePurchasePlan(data:FormData){return rpcAction(data,"approve_purchase_plan",{p_plan_id:uid(data,"p_plan_id")},"План закупок утверждён");}
export async function archivePurchasePlan(data:FormData){return rpcAction(data,"archive_purchase_plan",{p_plan_id:uid(data,"p_plan_id")},"План перемещён в архив");}
export async function createPurchasePlanVersion(data:FormData){const source=uid(data,"p_plan_id") as string;let created:string|null=null;try{const{supabase}=await requireUser();const{data:id,error}=await supabase.rpc("create_purchase_plan_version",{p_source_id:source});if(error)throw error;created=id as string;}catch(error){redirect(target(source,"error",message(error)));}revalidatePath("/purchase-plans");redirect(target(created,"success","Создан черновик новой версии"));}
export async function createShipmentFromPlan(data:FormData){const plan=uid(data,"p_plan_id") as string;let shipment:string|null=null;try{const{supabase}=await requireUser();const{data:id,error}=await supabase.rpc("create_purchase_plan_shipment",{p_plan_id:plan,p_route_id:uid(data,"p_route_id"),p_currency_id:uid(data,"p_currency_id"),p_warehouse_id:uid(data,"p_warehouse_id"),p_responsible_user_id:uid(data,"p_responsible_user_id"),p_planned_ready_date:val(data,"p_planned_ready_date")||null,p_planned_arrival_date:val(data,"p_planned_arrival_date")||null});if(error)throw error;shipment=id as string;}catch(error){redirect(target(plan,"error",message(error)));}revalidatePath("/purchase-plans");revalidatePath("/shipments");redirect(`/shipments/${shipment}?success=${encodeURIComponent("Поставка создана из утверждённого плана закупок")}`);}
