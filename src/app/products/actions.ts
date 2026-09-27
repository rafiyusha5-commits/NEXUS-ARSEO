"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PRODUCT_CATEGORIES } from "@/lib/products/categories";

export async function createProduct(formData: FormData) {
  const { supabase } = await requireUser();
  const sku = String(formData.get("internal_sku") ?? "").trim();
  const nameRu = String(formData.get("name_ru") ?? "").trim();
  const manufacturerId = String(formData.get("manufacturer_id") ?? "");
  const category = String(formData.get("category") ?? "");
  if (!sku || !nameRu || !manufacturerId || !PRODUCT_CATEGORIES.includes(category as (typeof PRODUCT_CATEGORIES)[number])) redirect("/products?error=" + encodeURIComponent("Заполните артикул, название, производителя и категорию."));

  const { data: product, error } = await supabase.from("products").insert({
    internal_sku: sku,
    name: { ru: nameRu, en: String(formData.get("name_en") ?? "").trim() || undefined, kk: String(formData.get("name_kk") ?? "").trim() || undefined },
    manufacturer_id: manufacturerId,
    brand: String(formData.get("brand") ?? "").trim() || null,
    category,
    country_of_origin: String(formData.get("country_of_origin") ?? "").trim().toUpperCase() || null,
    hs_code: String(formData.get("hs_code") ?? "").trim() || null,
    shelf_life_days: formData.get("shelf_life_days") ? Number(formData.get("shelf_life_days")) : null,
    base_uom: "piece",
    requires_marking: formData.get("requires_marking") === "on",
    requires_sticker: formData.get("requires_sticker") === "on",
    status: "active",
  }).select("id").single();
  if (error || !product) redirect("/products?error=" + encodeURIComponent(error?.message ?? "Товар не создан."));

  const identifiers = [
    { type: "supplier_sku", value: String(formData.get("supplier_sku") ?? "").trim(), counterparty_id: manufacturerId },
    { type: "gtin", value: String(formData.get("gtin") ?? "").trim(), counterparty_id: null },
    { type: "unit_barcode", value: String(formData.get("unit_barcode") ?? "").trim(), counterparty_id: null },
    { type: "box_barcode", value: String(formData.get("box_barcode") ?? "").trim(), counterparty_id: null },
  ].filter((item) => item.value).map((item) => ({ product_id: product.id, identifier_type: item.type, value: item.value, counterparty_id: item.counterparty_id, is_primary: item.type === "supplier_sku" || item.type === "gtin" }));
  if (identifiers.length) {
    const { error: identifierError } = await supabase.from("product_identifiers").insert(identifiers);
    if (identifierError) redirect("/products?error=" + encodeURIComponent("Товар создан, но идентификаторы требуют проверки: " + identifierError.message));
  }
  revalidatePath("/products");
  redirect("/products?success=" + encodeURIComponent("Карточка товара создана."));
}
