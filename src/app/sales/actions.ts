"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage, ruleViolationMessage } from "@/lib/errors/public-message";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value.trim():"";}
function uuid(data:FormData,key:string,required=true){const value=text(data,key);if(!value&&!required)return null;if(!uuidPattern.test(value))throw new Error(`Некорректное поле: ${key}`);return value;}
function number(data:FormData,key:string,required=false){const raw=text(data,key);if(!raw&&!required)return null;const value=Number(raw);if(!Number.isFinite(value))throw new Error(`Некорректное число: ${key}`);return value;}
function orderUrl(id:string,message:string,type:"error"|"success"="success",tab="main"){return `/sales/${id}?tab=${tab}&${type}=${encodeURIComponent(message)}`;}

export async function createCustomerOrder(data:FormData){
  const {supabase}=await requireUser();
  const {data:id,error}=await supabase.rpc("create_customer_order",{
    p_customer_id:uuid(data,"customer_id"),p_contract_id:uuid(data,"contract_id",false),p_warehouse_id:uuid(data,"warehouse_id"),
    p_planned_shipment_date:text(data,"planned_shipment_date"),p_currency_id:uuid(data,"currency_id",false),p_notes:text(data,"notes")||null,
  });
  if(error||!id)redirect(`/sales?error=${encodeURIComponent(publicErrorMessage(error,"Не удалось создать заказ."))}`);
  revalidatePath("/sales");redirect(orderUrl(id,"Заказ создан. Добавьте товары и выполните резервирование."));
}

export async function addCustomerOrderItem(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const quantity=number(data,"quantity",true);const required=number(data,"required_shelf_life_pct");const price=number(data,"unit_price");
  const {error}=await supabase.rpc("add_customer_order_item",{p_sale_id:saleId,p_product_id:uuid(data,"product_id"),p_quantity:quantity,p_uom:text(data,"uom"),p_unit_price:price,p_required_shelf_life_pct:required});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось добавить позицию."),"error","items"));revalidatePath(`/sales/${saleId}`);redirect(orderUrl(saleId,"Позиция добавлена","success","items"));
}

export async function reserveOrderItemFefo(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const {data:rows,error}=await supabase.rpc("reserve_customer_order_item_fefo",{p_sale_item_id:uuid(data,"sale_item_id")});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось создать резерв по FEFO."),"error","shipping"));revalidatePath(`/sales/${saleId}`);revalidatePath("/inventory");
  redirect(orderUrl(saleId,`Резерв создан по FEFO. Партий: ${Array.isArray(rows)?rows.length:0}`,"success","shipping"));
}

export async function reserveOrderItemOverride(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const {error}=await supabase.rpc("reserve_customer_order_item_override",{p_sale_item_id:uuid(data,"sale_item_id"),p_inventory_balance_id:uuid(data,"inventory_balance_id"),p_reason:text(data,"reason")});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось зарезервировать выбранную партию."),"error","shipping"));revalidatePath(`/sales/${saleId}`);revalidatePath("/inventory");redirect(orderUrl(saleId,"Выбранная партия зарезервирована с фиксацией отклонения от FEFO","success","shipping"));
}

export async function createGuaranteeLetter(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const {error}=await supabase.rpc("create_sale_guarantee_letter",{p_sale_id:saleId,p_notes:text(data,"notes")||null});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось сформировать гарантийное письмо."),"error","documents"));revalidatePath(`/sales/${saleId}`);redirect(orderUrl(saleId,"Черновик гарантийного письма сформирован по проблемным партиям","success","documents"));
}

export async function changeGuaranteeStatus(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const {error}=await supabase.rpc("change_sale_guarantee_status",{p_letter_id:uuid(data,"letter_id"),p_status:text(data,"status")});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось изменить статус гарантийного письма."),"error","documents"));revalidatePath(`/sales/${saleId}`);redirect(orderUrl(saleId,"Статус гарантийного письма обновлён","success","documents"));
}

export async function confirmCustomerOrder(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const {error}=await supabase.rpc("confirm_customer_order",{p_sale_id:saleId});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось подтвердить заказ."),"error"));revalidatePath(`/sales/${saleId}`);revalidatePath("/sales");redirect(orderUrl(saleId,"Заказ подтверждён"));
}

export async function cancelCustomerOrder(data:FormData){
  const {supabase}=await requireUser();const saleId=uuid(data,"sale_id")!;
  const {error}=await supabase.rpc("cancel_customer_order",{p_sale_id:saleId,p_reason:text(data,"reason")});
  if(error)redirect(orderUrl(saleId,publicErrorMessage(error,"Не удалось отменить заказ."),"error"));revalidatePath(`/sales/${saleId}`);revalidatePath("/sales");revalidatePath("/inventory");redirect(orderUrl(saleId,"Заказ отменён, резерв освобождён"));
}

export async function fulfillCustomerOrder(data: FormData) {
  const { supabase } = await requireUser();
  const saleId = uuid(data, "sale_id")!;
  const { error } = await supabase.rpc("fulfill_customer_order", { p_sale_id: saleId });
  if (error) redirect(orderUrl(saleId, ruleViolationMessage(error, "Не удалось отгрузить заказ."), "error", "shipping"));
  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/sales");
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  redirect(orderUrl(saleId, "Заказ отгружен. Резервы погашены, складские движения записаны.", "success", "shipping"));
}

export async function returnCustomerOrderToPreparation(data: FormData) {
  const { supabase } = await requireUser();
  const saleId = uuid(data, "sale_id")!;
  const { error } = await supabase.rpc("return_customer_order_to_preparation", {
    p_sale_id: saleId, p_reason: text(data, "reason"),
  });
  if (error) redirect(orderUrl(saleId, ruleViolationMessage(error), "error", "shipping"));
  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/sales");
  redirect(orderUrl(saleId, "Заказ возвращён к подготовке. Проверьте резервы и ОСГ, затем подтвердите заказ заново.", "success", "shipping"));
}

export async function rescheduleCustomerOrder(data: FormData) {
  const { supabase } = await requireUser();
  const saleId = uuid(data, "sale_id")!;
  const { error } = await supabase.rpc("reschedule_customer_order", {
    p_sale_id: saleId, p_date: text(data, "planned_shipment_date") || null, p_reason: text(data, "reason"),
  });
  if (error) redirect(orderUrl(saleId, ruleViolationMessage(error, "Не удалось перенести отгрузку."), "error", "shipping"));
  revalidatePath(`/sales/${saleId}`);
  revalidatePath("/sales");
  redirect(orderUrl(saleId, "Дата отгрузки перенесена", "success", "shipping"));
}
