"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

export async function createCounterparty(formData: FormData) {
  const { supabase } = await requireUser();
  const legalName = String(formData.get("legal_name") ?? "").trim();
  const role = String(formData.get("role") ?? "");
  const country = String(formData.get("country") ?? "").trim().toUpperCase();
  if (!legalName || !role || !/^[A-Z]{2}$/.test(country)) {
    redirect("/counterparties?error=" + encodeURIComponent("Укажите название, тип и двухбуквенный код страны."));
  }

  const { error } = await supabase.from("counterparties").insert({
    legal_name: legalName,
    short_name: String(formData.get("short_name") ?? "").trim() || null,
    roles: [role],
    country,
    tax_id: String(formData.get("tax_id") ?? "").trim() || null,
    preferred_locale: String(formData.get("preferred_locale") ?? "ru"),
    min_remaining_shelf_life_pct: formData.get("min_shelf_life") ? Number(formData.get("min_shelf_life")) : null,
  });
  if (error) redirect("/counterparties?error=" + encodeURIComponent(error.message));
  revalidatePath("/counterparties");
  redirect("/counterparties?success=" + encodeURIComponent("Контрагент добавлен."));
}
