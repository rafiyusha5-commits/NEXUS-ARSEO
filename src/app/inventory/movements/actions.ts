"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern=/^\d{4}-\d{2}-\d{2}$/;
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
 if(error)redirect(`/inventory/movements?error=${encodeURIComponent(error.message)}`);
 refresh(String(id));redirect(`${back(String(id),"items")}&success=${encodeURIComponent("Черновик создан. Добавьте товары и проведите документ.")}`);
}

export async function addInventoryOperationLine(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;const value=Number(text(data,"quantity"));
 if(!Number.isFinite(value)||value<=0)redirect(`${back(documentId,"items")}&error=${encodeURIComponent("Количество должно быть больше нуля")}`);
 const{error}=await supabase.rpc("add_inventory_operation_line",{
  p_document_id:documentId,p_source_balance_id:uuid(data,"source_balance_id"),p_to_location_id:uuid(data,"to_location_id",false),
  p_quantity:value,p_adjustment_direction:text(data,"adjustment_direction")||null,p_notes:text(data,"notes")||null,
 });
 if(error)redirect(`${back(documentId,"items")}&error=${encodeURIComponent(error.message)}`);
 refresh(documentId);redirect(`${back(documentId,"items")}&success=${encodeURIComponent("Товар добавлен в документ")}`);
}

export async function removeInventoryOperationLine(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;
 const{error}=await supabase.rpc("remove_inventory_operation_line",{p_line_id:uuid(data,"line_id")});
 if(error)redirect(`${back(documentId,"items")}&error=${encodeURIComponent(error.message)}`);
 refresh(documentId);redirect(`${back(documentId,"items")}&success=${encodeURIComponent("Строка удалена")}`);
}

export async function postInventoryOperation(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;
 const{error}=await supabase.rpc("post_inventory_operation_document",{p_document_id:documentId});
 if(error)redirect(`${back(documentId)}&error=${encodeURIComponent(error.message)}`);
 refresh(documentId);redirect(`${back(documentId)}&success=${encodeURIComponent("Документ проведён. Остатки и движения обновлены.")}`);
}

export async function cancelInventoryOperation(data:FormData){
 const{supabase}=await requireUser();const documentId=uuid(data,"document_id")!;const reason=text(data,"reason");
 if(!reason)redirect(`${back(documentId,"history")}&error=${encodeURIComponent("Укажите причину отмены")}`);
 const{error}=await supabase.rpc("cancel_inventory_operation_document",{p_document_id:documentId,p_reason:reason});
 if(error)redirect(`${back(documentId,"history")}&error=${encodeURIComponent(error.message)}`);
 refresh(documentId);redirect(`${back(documentId,"history")}&success=${encodeURIComponent("Документ отменён, движения сторнированы.")}`);
}
