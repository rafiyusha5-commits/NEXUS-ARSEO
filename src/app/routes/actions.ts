"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
export async function createRoute(formData:FormData){const{supabase}=await requireUser();const origin=String(formData.get("origin")??"").trim().toUpperCase();const destination=String(formData.get("destination")??"").trim().toUpperCase();const name=String(formData.get("name")??"").trim();if(!/^[A-Z]{2}$/.test(origin)||! /^[A-Z]{2}$/.test(destination)||!name)redirect("/routes?error="+encodeURIComponent("Укажите название и двухбуквенные коды стран."));const days=formData.get("days")?Number(formData.get("days")):null;const{error}=await supabase.from("routes").insert({origin_country:origin,destination_country:destination,name:{ru:name},typical_transit_days:days});if(error)redirect("/routes?error="+encodeURIComponent(error.message));revalidatePath("/routes");redirect("/routes?success="+encodeURIComponent("Маршрут добавлен."));}
