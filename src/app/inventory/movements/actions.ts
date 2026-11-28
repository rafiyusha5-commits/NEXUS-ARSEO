"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage, ruleViolationMessage } from "@/lib/errors/public-message";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
const reasonPattern=/^[a-z][a-z_]{1,39}$/;
function text(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value.trim():"";}
function uuid(data:FormData,key:string,required=true){const value=text(data,key);if(!value&&!required)return null;if(!uuidPattern.test(value))throw new Error(`Некорректное поле: ${key}`);return value;}
function back(id:string,tab="main"){return `/inventory/movements/${id}?tab=${tab}`;}
function refresh(id?:string){revalidatePath("/inventory");revalidatePath("/inventory/movements");revalidatePath("/warehouses");if(id)revalidatePath(`/inventory/movements/${id}`);}

export async function createInventoryOperation(data:FormData){
 const{supabase}=await requireUser();const operation=text(data,"operation_type");
 if(!["transfer","write_off","adjustment"].includes(operation))redirect(`/inventory/movements?error=${encodeURIComponent("Выберите вид операции")}`);
 const rawDate=text(data,"document_date");if(rawDate&&!datePattern.test(rawDate))redirect(`/inventory/movements?error=${encodeURIComponent("Проверьте дату документа")}`);
 const{data:id,error}=await supabase.rpc("create_inventory_operation_document",{
  p_operation_type:operation,p_document_date:rawDate||null,p_from_warehouse_id:uuid(data,"from_warehouse_id"),
  p_to_warehouse_id:uuid(data,"to_warehouse_id",false),p_reference:text(data,"reference")||null,
  p_reason:text(data,"reason")||null,p_performed_by_name:text(data,"performed_by_name")||null,
 });
 if(error)redirect(`/inventory/movements?error=${encodeURIComponent(publicErrorMessage(error,"Не удалось создать складской документ."))}`);
 refresh(String(id));redirect(`${back(String(id),"items")}&success=${encodeURIComponent("Черновик создан. Добавьте товары и проведите документ.")}`);
}

// A write-off or adjustment line goes with its reason in one call (202611280100): a write-off and a decrease are not
// posted without a reason. A transfer line has no reason.
export async function addInventoryOperationLine(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;const value=Number(text(data,"quantity"));
 if(!Number.isFinite(value)||value<=0)redirect(`${back(documentId,"items")}&error=${encodeURIComponent("Количество должно быть больше нуля")}`);
 const operation=text(data,"operation_type");const direction=text(data,"adjustment_direction")||null;const reason=text(data,"loss_reason_code")||null;
 if(reason&&!reasonPattern.test(reason))redirect(`${back(documentId,"items")}&error=${encodeURIComponent("Выберите причину списания")}`);
 const{error}=operation==="write_off"||operation==="adjustment"
  ?await supabase.rpc("add_inventory_loss_line",{
    p_document_id:documentId,p_source_balance_id:uuid(data,"source_balance_id"),p_quantity:value,p_adjustment_direction:direction,
    p_loss_reason_code:operation==="adjustment"&&direction!=="decrease"?null:reason,p_notes:text(data,"notes")||null,
   })
  :await supabase.rpc("add_inventory_operation_line",{
    p_document_id:documentId,p_source_balance_id:uuid(data,"source_balance_id"),p_to_location_id:uuid(data,"to_location_id",false),
    p_quantity:value,p_adjustment_direction:direction,p_notes:text(data,"notes")||null,
   });
 if(error)redirect(`${back(documentId,"items")}&error=${encodeURIComponent(ruleViolationMessage(error,"Не удалось добавить товар в документ."))}`);
 refresh(documentId);redirect(`${back(documentId,"items")}&success=${encodeURIComponent("Товар добавлен в документ")}`);
}

/** Reason of a line in a draft (whoever may change the document). */
export async function setInventoryLossReason(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;const reason=text(data,"loss_reason_code");
 if(!reasonPattern.test(reason))redirect(`${back(documentId,"items")}&error=${encodeURIComponent("Выберите причину списания")}`);
 const{error}=await supabase.rpc("set_inventory_loss_reason",{p_line_id:uuid(data,"line_id"),p_loss_reason_code:reason,p_basis:null});
 if(error)redirect(`${back(documentId,"items")}&error=${encodeURIComponent(ruleViolationMessage(error,"Не удалось сохранить причину."))}`);
 refresh(documentId);redirect(`${back(documentId,"items")}&success=${encodeURIComponent("Причина сохранена")}`);
}

export async function removeInventoryOperationLine(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;
 const{error}=await supabase.rpc("remove_inventory_operation_line",{p_line_id:uuid(data,"line_id")});
 if(error)redirect(`${back(documentId,"items")}&error=${encodeURIComponent(publicErrorMessage(error,"Не удалось удалить строку документа."))}`);
 refresh(documentId);redirect(`${back(documentId,"items")}&success=${encodeURIComponent("Строка удалена")}`);
}

export async function postInventoryOperation(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;
 const{error}=await supabase.rpc("post_inventory_operation_document",{p_document_id:documentId});
 if(error)redirect(`${back(documentId)}&error=${encodeURIComponent(ruleViolationMessage(error,"Не удалось провести складской документ."))}`);
 refresh(documentId);redirect(`${back(documentId)}&success=${encodeURIComponent("Документ проведён. Остатки и движения обновлены.")}`);
}

export async function cancelInventoryOperation(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;const reason=text(data,"reason");
 if(!reason)redirect(`${back(documentId,"history")}&error=${encodeURIComponent("Укажите причину отмены")}`);
 const{error}=await supabase.rpc("cancel_inventory_operation_document",{p_document_id:documentId,p_reason:reason});
 if(error)redirect(`${back(documentId,"history")}&error=${encodeURIComponent(publicErrorMessage(error,"Не удалось отменить складской документ."))}`);
 refresh(documentId);redirect(`${back(documentId,"history")}&success=${encodeURIComponent("Документ отменён, движения сторнированы.")}`);
}
