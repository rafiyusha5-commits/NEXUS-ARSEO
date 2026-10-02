"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function createWarehouse(formData: FormData) {
  const { supabase } = await requireUser();
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const name = String(formData.get("name") ?? "").trim();
  const isVirtual = formData.get("is_virtual") === "on";
  const city = String(formData.get("city") ?? "").trim();
  const country = String(formData.get("country") ?? "").trim().toUpperCase();
  if (!code || !name || (!isVirtual && (!city || !/^[A-Z]{2}$/.test(country)))) redirect("/warehouses?error=" + encodeURIComponent("Заполните код, название, город и страну."));
  const { error } = await supabase.from("warehouses").insert({ code, name:{ru:name}, city:city||null, country:country||null, address:String(formData.get("address")??"").trim()||null, is_virtual:isVirtual, is_main_hub:formData.get("is_main_hub")==="on" });
  if (error) redirect("/warehouses?error=" + encodeURIComponent(error.message));
  revalidatePath("/warehouses"); redirect("/warehouses?success=" + encodeURIComponent("Склад добавлен."));
}

export async function createLocation(formData: FormData) {
  const { supabase } = await requireUser();
  const warehouseId=String(formData.get("warehouse_id")??""); const code=String(formData.get("code")??"").trim().toUpperCase(); const zone=String(formData.get("zone")??"");
  const returnTo=String(formData.get("return_to")??"");
  const target=uuidPattern.test(returnTo)?`/warehouses/${returnTo}?tab=zones`:"/warehouses?tab=main";
  if(!warehouseId||!code||!zone) redirect(target+"&error="+encodeURIComponent("Заполните склад, код и тип зоны."));
  const {error}=await supabase.from("warehouse_locations").insert({warehouse_id:warehouseId,code,zone});
  if(error) redirect(target+"&error="+encodeURIComponent(error.message));
  revalidatePath("/warehouses");revalidatePath(`/warehouses/${warehouseId}`);redirect(target+"&success="+encodeURIComponent("Зона склада добавлена."));
}
