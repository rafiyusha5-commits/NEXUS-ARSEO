"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

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
  if(!warehouseId||!code||!zone) redirect("/warehouses?error="+encodeURIComponent("Заполните склад, код и тип зоны."));
  const {error}=await supabase.from("warehouse_locations").insert({warehouse_id:warehouseId,code,zone});
  if(error) redirect("/warehouses?error="+encodeURIComponent(error.message));
  revalidatePath("/warehouses"); redirect("/warehouses?success="+encodeURIComponent("Зона склада добавлена."));
}
