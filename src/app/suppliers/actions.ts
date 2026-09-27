"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

export async function createSupplier(formData: FormData) {
  const { supabase } = await requireUser();
  const legalName = String(formData.get("legal_name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const country = String(formData.get("country") ?? "").trim().toUpperCase();
  if (!legalName || !["manufacturer", "supplier"].includes(role) || !/^[A-Z]{2}$/.test(country)) {
    redirect("/suppliers?error=" + encodeURIComponent("Укажите название, тип поставщика и двухбуквенный код страны."));
  }
  const roles = role === "manufacturer" ? ["manufacturer", "supplier"] : ["supplier"];
  const { error } = await supabase.from("counterparties").insert({
    legal_name: legalName,
    short_name: String(formData.get("short_name") ?? "").trim() || null,
    roles,
    country,
    tax_id: String(formData.get("tax_id") ?? "").trim() || null,
    preferred_locale: String(formData.get("preferred_locale") ?? "en"),
  });
  if (error) redirect("/suppliers?error=" + encodeURIComponent(error.message));
  revalidatePath("/suppliers");
  revalidatePath("/products");
  redirect("/suppliers?success=" + encodeURIComponent("Поставщик добавлен."));
}

