"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

export async function createCounterparty(formData: FormData) {
  const { supabase } = await requireUser();
  const legalName = String(formData.get("legal_name") ?? "").trim();
  const allowedRoles = new Set(["customer", "supplier", "manufacturer", "carrier", "broker", "printing_house", "other"]);
  const roles = [...new Set(formData.getAll("roles").map(String).filter((role) => allowedRoles.has(role)))];
  if (roles.includes("manufacturer") && !roles.includes("supplier")) roles.push("supplier");
  const country = String(formData.get("country") ?? "").trim().toUpperCase();
  if (!legalName || !roles.length || !/^[A-Z]{2}$/.test(country)) {
    redirect("/counterparties?error=" + encodeURIComponent("Укажите название, тип и двухбуквенный код страны."));
  }

  const { data: granted, error: permissionError } = await supabase.rpc("my_permissions", {
    p_codes: ["customers.create", "suppliers.create"],
  });
  const permissions = new Set((granted ?? []) as string[]);
  const needsCustomerAccess = roles.includes("customer");
  const needsSupplierAccess = roles.some((role) => role !== "customer");
  if (permissionError || (needsCustomerAccess && !permissions.has("customers.create")) || (needsSupplierAccess && !permissions.has("suppliers.create"))) {
    redirect("/counterparties?error=" + encodeURIComponent("Недостаточно прав для создания контрагента с выбранными ролями."));
  }

  const { error } = await supabase.from("counterparties").insert({
    legal_name: legalName,
    short_name: String(formData.get("short_name") ?? "").trim() || null,
    roles,
    country,
    tax_id: String(formData.get("tax_id") ?? "").trim() || null,
    preferred_locale: String(formData.get("preferred_locale") ?? "ru"),
    min_remaining_shelf_life_pct: formData.get("min_shelf_life") ? Number(formData.get("min_shelf_life")) : null,
  });
  if (error) redirect("/counterparties?error=" + encodeURIComponent(error.message));
  revalidatePath("/counterparties");
  revalidatePath("/suppliers");
  revalidatePath("/products");
  redirect("/counterparties?success=" + encodeURIComponent("Контрагент добавлен."));
}
