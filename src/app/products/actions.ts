"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { PRODUCT_CATEGORIES } from "@/lib/products/categories";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const identifierTypes = new Set(["supplier_sku", "gtin", "unit_barcode", "box_barcode"]);
const packagingUnits = new Set(["piece", "box", "layer", "pallet", "truck"]);
const value = (formData: FormData, key: string) => String(formData.get(key) ?? "").trim();
const productUrl = (id: string, tab: string, kind: "error" | "success", message: string) => `/products/${id}?tab=${tab}&${kind}=${encodeURIComponent(message)}`;

export async function createProduct(formData: FormData) {
  const { supabase } = await requireUser();
  const sku = String(formData.get("internal_sku") ?? "").trim();
  const nameRu = String(formData.get("name_ru") ?? "").trim();
  const manufacturerId = String(formData.get("manufacturer_id") ?? "");
  const category = String(formData.get("category") ?? "");
  if (!sku || !nameRu || !uuidPattern.test(manufacturerId) || !PRODUCT_CATEGORIES.includes(category as (typeof PRODUCT_CATEGORIES)[number])) redirect("/products?error=" + encodeURIComponent("Заполните артикул, название, завод-поставщик и категорию."));

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

export async function addProductIdentifier(formData: FormData) {
  const { supabase } = await requireUser();
  const productId = value(formData, "product_id");
  const identifierType = value(formData, "identifier_type");
  const identifierValue = value(formData, "value");
  const counterpartyId = value(formData, "counterparty_id");
  if (!uuidPattern.test(productId)) redirect("/products?error=" + encodeURIComponent("Товар не найден."));
  if (!identifierTypes.has(identifierType) || !identifierValue || (identifierType === "supplier_sku" && !uuidPattern.test(counterpartyId))) {
    redirect(productUrl(productId, "identifiers", "error", "Заполните тип, значение и поставщика для артикула поставщика."));
  }
  const { error } = await supabase.from("product_identifiers").insert({
    product_id: productId,
    identifier_type: identifierType,
    value: identifierValue,
    counterparty_id: identifierType === "supplier_sku" ? counterpartyId : null,
    packaging_uom: value(formData, "packaging_uom") || null,
    is_primary: formData.get("is_primary") === "on",
  });
  if (error) redirect(productUrl(productId, "identifiers", "error", error.message));
  revalidatePath(`/products/${productId}`);
  redirect(productUrl(productId, "identifiers", "success", "Идентификатор добавлен."));
}

export async function addProductPackaging(formData: FormData) {
  const { supabase } = await requireUser();
  const productId = value(formData, "product_id");
  const uom = value(formData, "uom");
  const units = Number(value(formData, "units_per_parent"));
  if (!uuidPattern.test(productId)) redirect("/products?error=" + encodeURIComponent("Товар не найден."));
  if (!packagingUnits.has(uom) || !Number.isFinite(units) || units <= 0) redirect(productUrl(productId, "packaging", "error", "Укажите единицу и количество больше нуля."));
  const numberOrNull = (key: string) => { const raw = value(formData, key); return raw ? Number(raw) : null; };
  const payload = {
    product_id: productId, uom, units_per_parent: units,
    gross_weight_kg: numberOrNull("gross_weight_kg"), net_weight_kg: numberOrNull("net_weight_kg"), volume_m3: numberOrNull("volume_m3"),
    length_cm: numberOrNull("length_cm"), width_cm: numberOrNull("width_cm"), height_cm: numberOrNull("height_cm"),
  };
  if (Object.values(payload).some((item) => typeof item === "number" && (!Number.isFinite(item) || item < 0))) redirect(productUrl(productId, "packaging", "error", "Вес, объём и размеры должны быть неотрицательными числами."));
  const { error } = await supabase.from("product_packaging").insert(payload);
  if (error) redirect(productUrl(productId, "packaging", "error", error.message));
  revalidatePath(`/products/${productId}`);
  redirect(productUrl(productId, "packaging", "success", "Упаковка добавлена."));
}
