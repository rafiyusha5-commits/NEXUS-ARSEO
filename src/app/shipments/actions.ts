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
  const {data:existing,error:readError}=await supabase.from("shipment_transports").select("id,sequence_no").eq("shipment_id",shipmentId).order("sequence_no",{ascending:false});
  if(readError)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(readError.message)}`);
  const sequenceNo=(existing?.[0]?.sequence_no??0)+1;
  const {data:transport,error}=await supabase.from("shipment_transports").insert({shipment_id:shipmentId,sequence_no:sequenceNo,planned_loading_date:text(formData,"planned_loading_date")||null,planned_arrival_date:text(formData,"planned_arrival_date")||null,temperature_setpoint:text(formData,"temperature_setpoint")||null,notes:text(formData,"notes")||null,status:"planned"}).select("id").single();
  if(error||!transport)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(error?.message??"Не удалось создать перевозку")}`);
  const {data:shipment}=await supabase.from("shipments").select("process_template_id,responsible_user_id").eq("id",shipmentId).single();
  const {data:stages}=shipment?await supabase.from("shipment_stages").select("id,requirement").eq("process_template_id",shipment.process_template_id).eq("scope","transport").eq("is_active",true):{data:[]};
  const stageIds=(stages??[]).map((stage)=>stage.id);
  if(stageIds.length){
    if(!existing?.length){const {error:stageError}=await supabase.from("shipment_stage_runs").update({shipment_transport_id:transport.id}).eq("shipment_id",shipmentId).is("shipment_transport_id",null).in("stage_id",stageIds);if(stageError)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(`Перевозка создана, но этапы не связаны: ${stageError.message}`)}`);}
    else {const {error:stageError}=await supabase.from("shipment_stage_runs").insert((stages??[]).map((stage)=>({shipment_id:shipmentId,stage_id:stage.id,shipment_transport_id:transport.id,is_required:stage.requirement==="required",status:stage.requirement==="conditional"?"not_applicable":"pending",responsible_user_id:shipment?.responsible_user_id,status_reason:stage.requirement==="conditional"?"Будет активирован при выполнении условия":null})));if(stageError)redirect(`/shipments/${shipmentId}?error=${encodeURIComponent(`Перевозка создана, но этапы не добавлены: ${stageError.message}`)}`);}
  }
  revalidatePath(`/shipments/${shipmentId}`); redirect(`/shipments/${shipmentId}?success=${encodeURIComponent(`Перевозка №${sequenceNo} добавлена`)}`);
}
