"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function value(formData: FormData, key: string) { return String(formData.get(key) ?? "").trim(); }
function counterpartyUrl(id: string, tab: string, message: string, type: "error" | "success" = "success") {
  return `/counterparties/${id}?tab=${tab}&${type}=${encodeURIComponent(message)}`;
}

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

export async function addCounterpartyContact(formData: FormData) {
  const { supabase } = await requireUser();
  const counterpartyId = value(formData, "counterparty_id");
  const fullName = value(formData, "full_name");
  if (!uuidPattern.test(counterpartyId)) redirect("/counterparties?error=" + encodeURIComponent("Контрагент не найден."));
  if (!fullName) redirect(counterpartyUrl(counterpartyId, "contacts", "Укажите ФИО контактного лица.", "error"));
  const { error } = await supabase.from("counterparties_contacts").insert({
    counterparty_id: counterpartyId,
    full_name: fullName,
    position: value(formData, "position") || null,
    phone: value(formData, "phone") || null,
    whatsapp_phone: value(formData, "whatsapp_phone") || null,
    email: value(formData, "email") || null,
    is_primary: formData.get("is_primary") === "on",
  });
  if (error) redirect(counterpartyUrl(counterpartyId, "contacts", error.message, "error"));
  revalidatePath(`/counterparties/${counterpartyId}`);
  redirect(counterpartyUrl(counterpartyId, "contacts", "Контакт добавлен."));
}

export async function addCounterpartyContract(formData: FormData) {
  const { supabase } = await requireUser();
  const counterpartyId = value(formData, "counterparty_id");
  const number = value(formData, "number");
  const allowedTypes = new Set(["supply", "sale", "service", "agency", "nda", "other"]);
  const contractType = value(formData, "type");
  const currencyId = value(formData, "currency_id");
  if (!uuidPattern.test(counterpartyId)) redirect("/counterparties?error=" + encodeURIComponent("Контрагент не найден."));
  if (!number || !allowedTypes.has(contractType) || (currencyId && !uuidPattern.test(currencyId))) {
    redirect(counterpartyUrl(counterpartyId, "contracts", "Проверьте номер, тип и валюту договора.", "error"));
  }
  const { error } = await supabase.from("contracts").insert({
    counterparty_id: counterpartyId,
    number,
    type: contractType,
    currency_id: currencyId || null,
    sign_date: value(formData, "sign_date") || null,
    valid_from: value(formData, "valid_from") || null,
    valid_to: value(formData, "valid_to") || null,
    incoterms: value(formData, "incoterms") || null,
    notes: value(formData, "notes") || null,
  });
  if (error) redirect(counterpartyUrl(counterpartyId, "contracts", error.message, "error"));
  revalidatePath(`/counterparties/${counterpartyId}`);
  redirect(counterpartyUrl(counterpartyId, "contracts", "Договор добавлен."));
}
