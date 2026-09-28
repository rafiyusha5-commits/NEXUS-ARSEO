"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth/access";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(formData: FormData, name: string) { const value=formData.get(name); return typeof value==="string"?value.trim():""; }
function uuid(formData: FormData, name: string, required=true) { const value=text(formData,name); if(!value&&!required)return null; if(!uuidPattern.test(value))throw new Error(`Некорректное поле: ${name}`); return value; }

export async function createShipment(formData: FormData) {
  const {profile,supabase}=await requireUser();
  const shipmentType=text(formData,"type");
  const supplierId=uuid(formData,"supplier_id",false);
  const customerId=uuid(formData,"customer_id",false);
  if(!["import","export","domestic_transfer"].includes(shipmentType)) redirect(`/shipments?error=${encodeURIComponent("Выберите тип поставки")}`);
  if(shipmentType==="import"&&!supplierId) redirect(`/shipments?error=${encodeURIComponent("Для импорта выберите поставщика")}`);
  if(shipmentType==="export"&&!customerId) redirect(`/shipments?error=${encodeURIComponent("Для экспорта выберите клиента")}`);
  const {data,error}=await supabase.rpc("create_shipment_with_stages",{
    p_project_code:text(formData,"project_code"),p_type:shipmentType,p_supplier_id:supplierId,p_customer_id:customerId,
    p_route_id:uuid(formData,"route_id"),p_currency_id:uuid(formData,"currency_id"),p_warehouse_id:uuid(formData,"warehouse_id"),
    p_responsible_user_id:text(formData,"responsible_user_id")||profile.id,p_planned_ready_date:text(formData,"planned_ready_date")||null,p_planned_arrival_date:text(formData,"planned_arrival_date")||null,
  });
  if(error||!data) redirect(`/shipments?error=${encodeURIComponent(error?.message??"Не удалось создать поставку")}`);
  revalidatePath("/shipments"); revalidatePath("/");
  redirect(`/shipments/${data}?success=${encodeURIComponent("Поставка создана. Этапы RVI добавлены автоматически.")}`);
}

export async function changeStageStatus(formData: FormData) {
  const {supabase}=await requireUser();
  const runId=uuid(formData,"run_id"); const shipmentId=uuid(formData,"shipment_id");
  const status=text(formData,"status"); const reason=text(formData,"reason");
  if(!["pending","in_progress","blocked","completed","skipped","not_applicable"].includes(status)) redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Некорректный статус этапа")}`);
  if(["blocked","skipped","not_applicable"].includes(status)&&!reason) redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Для этого действия укажите причину")}`);
  const {error}=await supabase.rpc("change_shipment_stage_status",{p_run_id:runId,p_status:status,p_reason:reason||null,p_performed_by_name:text(formData,"performed_by_name")||null});
  if(error) redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); revalidatePath("/shipments"); revalidatePath("/");
  redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Статус этапа обновлён")}`);
}

export async function addShipmentItem(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  const quantity=Number(text(formData,"ordered_quantity")); const priceText=text(formData,"unit_price");
  if(!Number.isFinite(quantity)||quantity<=0)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Количество должно быть больше нуля")}`);
  const price=priceText?Number(priceText):null;
  if(price!==null&&(!Number.isFinite(price)||price<0))redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Цена не может быть отрицательной")}`);
  const {error}=await supabase.from("shipment_items").insert({shipment_id:shipmentId,product_id:uuid(formData,"product_id"),uom:text(formData,"uom")||"piece",ordered_quantity:quantity,unit_price:price,currency_id:uuid(formData,"currency_id",false)});
  if(error)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Позиция добавлена")}`);
}

export async function addShipmentTransport(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  // One transaction in the database: the vehicle, its number and its transport stages.
  const {data:sequenceNo,error}=await supabase.rpc("add_shipment_transport",{
    p_shipment_id:shipmentId,
    p_planned_loading_date:text(formData,"planned_loading_date")||null,
    p_planned_arrival_date:text(formData,"planned_arrival_date")||null,
    p_temperature_setpoint:text(formData,"temperature_setpoint")||null,
    p_notes:text(formData,"notes")||null,
  });
  if(error||!sequenceNo)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error?.message??"Не удалось создать перевозку")}`);
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent(`Перевозка №${sequenceNo} добавлена`)}`);
}

export async function allocateShipmentItem(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  const quantity=Number(text(formData,"quantity"));
  if(!Number.isFinite(quantity)||quantity<=0)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Количество для распределения должно быть больше нуля")}`);
  const {error}=await supabase.rpc("allocate_shipment_item",{p_item_id:uuid(formData,"item_id"),p_transport_id:uuid(formData,"transport_id",false),p_quantity:quantity});
  if(error)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Товар распределён по перевозкам")}`);
}

export async function updateShipmentItem(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  const quantity=Number(text(formData,"quantity")); const priceText=text(formData,"unit_price");
  const price=priceText?Number(priceText):null;
  if(!Number.isFinite(quantity)||quantity<=0)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Количество должно быть больше нуля")}`);
  if(price!==null&&(!Number.isFinite(price)||price<0))redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Цена не может быть отрицательной")}`);
  const {error}=await supabase.rpc("update_shipment_item",{p_item_id:uuid(formData,"item_id"),p_quantity:quantity,p_unit_price:price});
  if(error)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Позиция обновлена")}`);
}

export async function deleteShipmentItem(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  const {error}=await supabase.rpc("delete_shipment_item",{p_item_id:uuid(formData,"item_id")});
  if(error)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Позиция удалена")}`);
}

export async function changeShipmentTransportStatus(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  const status=text(formData,"status");
  if(!["planned","loading","in_transit","at_customs","arrived","unloaded","cancelled"].includes(status))redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Некорректный статус перевозки")}`);
  const {error}=await supabase.rpc("change_shipment_transport_status",{p_transport_id:uuid(formData,"transport_id"),p_status:status});
  if(error)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Статус перевозки обновлён")}`);
}

export async function changeShipmentOperationalState(formData:FormData){
  const {supabase}=await requireUser(); const shipmentId=uuid(formData,"shipment_id");
  const action=text(formData,"operation"); const reason=text(formData,"reason");
  if(!["hold","resume","cancel"].includes(action))redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Некорректное действие с поставкой")}`);
  if(["hold","cancel"].includes(action)&&!reason)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent("Укажите причину")}`);
  const {error}=await supabase.rpc("change_shipment_operational_state",{p_shipment_id:shipmentId,p_action:action,p_reason:reason||null});
  if(error)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error.message)}`);
  revalidatePath(`/shipments/${shipmentId}`); revalidatePath("/shipments"); revalidatePath("/");
  const messages:Record<string,string>={hold:"Поставка приостановлена",resume:"Поставка возобновлена",cancel:"Поставка отменена"};
  redirect(`/shipments/${shipmentId}?success=${encodeURIComponent(messages[action])}`);
}

export async function receiveShipmentTransport(formData:FormData){
  const {profile,supabase}=await requireUser();
  const shipmentId=uuid(formData,"shipment_id");
  const transportId=uuid(formData,"transport_id");
  const itemIds=formData.getAll("item_id").map((value)=>typeof value==="string"?value.trim():"");
  const accepted=formData.getAll("accepted_quantity").map((value)=>typeof value==="string"?value.trim():"");
  const damaged=formData.getAll("damaged_quantity").map((value)=>typeof value==="string"?value.trim():"");
  const batches=formData.getAll("batch_number").map((value)=>typeof value==="string"?value.trim():"");
  const manufactured=formData.getAll("manufacture_date").map((value)=>typeof value==="string"?value.trim():"");
  const expires=formData.getAll("expiry_date").map((value)=>typeof value==="string"?value.trim():"");
  const reasons=formData.getAll("discrepancy_reason").map((value)=>typeof value==="string"?value.trim():"");
  const lengths=[itemIds.length,accepted.length,damaged.length,batches.length,manufactured.length,expires.length,reasons.length];
  if(!itemIds.length||lengths.some((length)=>length!==itemIds.length)){
    redirect(`/shipments/${shipmentId}/receiving?transport=${transportId}&error=${encodeURIComponent("Позиции приёмки переданы не полностью")}`);
  }
  const lines=itemIds.map((itemId,index)=>{
    if(!uuidPattern.test(itemId))throw new Error("Некорректная позиция приёмки");
    const acceptedQuantity=Number(accepted[index]);
    const damagedQuantity=damaged[index]?Number(damaged[index]):0;
    if(!Number.isFinite(acceptedQuantity)||acceptedQuantity<0||!Number.isFinite(damagedQuantity)||damagedQuantity<0){
      throw new Error("Количество при приёмке не может быть отрицательным");
    }
    return {
      item_id:itemId,
      accepted_quantity:acceptedQuantity,
      damaged_quantity:damagedQuantity,
      batch_number:batches[index]||null,
      manufacture_date:manufactured[index]||null,
      expiry_date:expires[index]||null,
      discrepancy_reason:reasons[index]||null,
    };
  });
  const locationId=uuid(formData,"location_id",false);
  const performedByName=text(formData,"performed_by_name")||profile.full_name;
  const {error}=await supabase.rpc("receive_shipment_transport",{
    p_transport_id:transportId,
    p_location_id:locationId,
    p_lines:lines,
    p_performed_by_name:performedByName,
    p_notes:text(formData,"notes")||null,
  });
  if(error){
    redirect(`/shipments/${shipmentId}/receiving?transport=${transportId}&error=${encodeURIComponent(error.message)}`);
  }
  revalidatePath(`/shipments/${shipmentId}`);
  revalidatePath(`/shipments/${shipmentId}/receiving`);
  revalidatePath("/inventory");
  revalidatePath("/inventory/movements");
  revalidatePath("/shipments");
  revalidatePath("/");
  redirect(`/shipments/${shipmentId}?success=${encodeURIComponent("Автомобиль принят. Партии и остатки зарегистрированы.")}`);
}
