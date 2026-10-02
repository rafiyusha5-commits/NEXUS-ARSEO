"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value.trim():"";}
function uuid(data:FormData,key:string,required=true){const value=text(data,key);if(!value&&!required)return null;if(!uuidPattern.test(value))throw new Error(`Некорректное поле: ${key}`);return value;}
function date(data:FormData,key:string,required=false){const value=text(data,key);if(!value&&!required)return null;if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error(`Некорректная дата: ${key}`);return value;}

export async function receiveBatch(data:FormData){
  const {supabase}=await requireUser();
  const quantity=Number(text(data,"quantity"));
  if(!Number.isFinite(quantity)||quantity<=0)redirect(`/inventory?error=${encodeURIComponent("Количество должно быть больше нуля")}`);
  const {error}=await supabase.rpc("receive_inventory_batch",{
    p_shipment_item_id:uuid(data,"shipment_item_id"),
    p_warehouse_id:uuid(data,"warehouse_id"),
    p_location_id:uuid(data,"location_id",false),
    p_batch_number:text(data,"batch_number"),
    p_manufacture_date:date(data,"manufacture_date"),
    p_expiry_date:date(data,"expiry_date",true),
    p_quantity:quantity,
    p_notes:text(data,"notes")||null,
  });
  if(error)redirect(`/inventory?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/inventory");revalidatePath("/warehouses");
  redirect(`/inventory?success=${encodeURIComponent("Партия принята и добавлена в остатки")}`);
}

export async function issueFifo(data:FormData){
  const {supabase}=await requireUser();
  const quantity=Number(text(data,"quantity"));
  if(!Number.isFinite(quantity)||quantity<=0)redirect(`/inventory?error=${encodeURIComponent("Количество должно быть больше нуля")}`);
  const {data:allocations,error}=await supabase.rpc("issue_inventory_fifo",{
    p_product_id:uuid(data,"product_id"),
    p_warehouse_id:uuid(data,"warehouse_id"),
    p_uom:text(data,"uom"),
    p_quantity:quantity,
    p_reference:text(data,"reference")||null,
    p_reason:text(data,"reason"),
  });
  if(error)redirect(`/inventory?error=${encodeURIComponent(error.message)}`);
  const count=Array.isArray(allocations)?allocations.length:0;
  revalidatePath("/inventory");
  redirect(`/inventory?success=${encodeURIComponent(`Списание выполнено по FIFO, использовано партий: ${count}`)}`);
}

export async function setBatchStatus(data:FormData){
  const {supabase}=await requireUser();
  const batchId=uuid(data,"batch_id");
  const returnTo=text(data,"return_to");
  const target=uuidPattern.test(returnTo)?`/inventory/${returnTo}?tab=main`:"/inventory?tab=main";
  const status=text(data,"status");
  if(!["available","quarantine","blocked"].includes(status))redirect(`${target}&error=${encodeURIComponent("Выберите корректное состояние партии")}`);
  const {error}=await supabase.rpc("set_inventory_batch_status",{
    p_batch_id:batchId,
    p_status:status,
    p_reason:text(data,"reason")||null,
  });
  if(error)redirect(`${target}&error=${encodeURIComponent(error.message)}`);
  revalidatePath("/inventory");revalidatePath(`/inventory/${batchId}`);
  const label=status==="available"?"разблокирована":status==="quarantine"?"отправлена в карантин":"заблокирована";
  redirect(`${target}&success=${encodeURIComponent(`Партия ${label}`)}`);
}
