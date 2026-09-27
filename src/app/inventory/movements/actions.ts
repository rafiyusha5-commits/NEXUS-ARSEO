"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(data:FormData,key:string){const value=data.get(key);return typeof value==="string"?value.trim():"";}
function uuid(data:FormData,key:string,required=true){const value=text(data,key);if(!value&&!required)return null;if(!uuidPattern.test(value))throw new Error(`Некорректное поле: ${key}`);return value;}
function quantity(data:FormData){const value=Number(text(data,"quantity"));if(!Number.isFinite(value)||value<=0)redirect(`/inventory/movements?error=${encodeURIComponent("Количество должно быть больше нуля")}`);return value;}

export async function transferInventory(data:FormData){
  const {supabase}=await requireUser();
  const {error}=await supabase.rpc("transfer_inventory_batch",{
    p_balance_id:uuid(data,"balance_id"),p_to_warehouse_id:uuid(data,"to_warehouse_id"),p_to_location_id:uuid(data,"to_location_id",false),
    p_quantity:quantity(data),p_reference:text(data,"reference")||null,p_reason:text(data,"reason")||null,p_performed_by_name:text(data,"performed_by_name")||null,
  });
  if(error)redirect(`/inventory/movements?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/inventory");revalidatePath("/inventory/movements");revalidatePath("/warehouses");
  redirect(`/inventory/movements?success=${encodeURIComponent("Перемещение выполнено и записано двумя связанными движениями")}`);
}

export async function writeOffInventory(data:FormData){
  const {supabase}=await requireUser();
  const {error}=await supabase.rpc("write_off_inventory",{
    p_balance_id:uuid(data,"balance_id"),p_quantity:quantity(data),p_reason:text(data,"reason"),
    p_reference:text(data,"reference")||null,p_performed_by_name:text(data,"performed_by_name")||null,
  });
  if(error)redirect(`/inventory/movements?error=${encodeURIComponent(error.message)}`);
  revalidatePath("/inventory");revalidatePath("/inventory/movements");revalidatePath("/warehouses");
  redirect(`/inventory/movements?success=${encodeURIComponent("Списание выполнено и зафиксировано в журнале")}`);
}
