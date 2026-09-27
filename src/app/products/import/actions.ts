"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";

type ImportRow = {
  rowNumber: number;
  internalSku: string;
  nameRu: string;
  nameEn?: string;
  nameKk?: string;
  manufacturerId: string;
  brand?: string;
  supplierSku?: string;
  gtin?: string;
  unitBarcode?: string;
  boxBarcode?: string;
  hsCode?: string;
  countryOfOrigin?: string;
  shelfLifeDays?: number | null;
  requiresSticker?: boolean;
  requiresMarking?: boolean;
};

function go(kind: "error" | "success", message: string): never {
  redirect(`/products/import?${kind}=${encodeURIComponent(message)}`);
}

export async function importProducts(formData: FormData) {
  const { supabase } = await requireUser();
  let rows: ImportRow[];
  try {
    rows = JSON.parse(String(formData.get("rows_json") ?? "[]"));
  } catch {
    go("error", "Не удалось прочитать подготовленные строки.");
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 500) go("error", "За один раз можно импортировать от 1 до 500 строк.");

  const cleaned = rows.map((row) => ({
    ...row,
    internalSku: String(row.internalSku ?? "").trim(),
    nameRu: String(row.nameRu ?? "").trim(),
    manufacturerId: String(row.manufacturerId ?? ""),
  }));
  if (cleaned.some((row) => !row.internalSku || !row.nameRu || !row.manufacturerId)) go("error", "В файле есть строки без артикула, названия или производителя.");

  const manufacturerIds = [...new Set(cleaned.map((row) => row.manufacturerId))];
  const { data: allowedManufacturers } = await supabase.from("counterparties").select("id").in("id", manufacturerIds);
  const allowed = new Set((allowedManufacturers ?? []).map((item) => item.id));
  if (manufacturerIds.some((id) => !allowed.has(id))) go("error", "Один из производителей недоступен или был удалён.");

  const skus = cleaned.map((row) => row.internalSku);
  const { data: existingProducts } = await supabase.from("products").select("internal_sku").in("internal_sku", skus);
  const existingSkus = new Set((existingProducts ?? []).map((item) => item.internal_sku));
  const uniqueRows = cleaned.filter((row, index, all) => !existingSkus.has(row.internalSku) && all.findIndex((other) => other.internalSku === row.internalSku) === index);
  const skipped = cleaned.length - uniqueRows.length;
  if (!uniqueRows.length) go("error", "Все строки пропущены: такие внутренние артикулы уже существуют или повторяются в файле.");

  const { data: inserted, error } = await supabase.from("products").insert(uniqueRows.map((row) => ({
    internal_sku: row.internalSku,
    name: { ru: row.nameRu, ...(row.nameEn ? { en: row.nameEn } : {}), ...(row.nameKk ? { kk: row.nameKk } : {}) },
    manufacturer_id: row.manufacturerId,
    brand: row.brand || null,
    country_of_origin: row.countryOfOrigin || null,
    hs_code: row.hsCode || null,
    shelf_life_days: row.shelfLifeDays || null,
    base_uom: "piece",
    requires_sticker: Boolean(row.requiresSticker),
    requires_marking: Boolean(row.requiresMarking),
    status: "active",
  }))).select("id, internal_sku");
  if (error || !inserted) go("error", error?.message ?? "Supabase не создал товары.");

  const idsBySku = new Map(inserted.map((item) => [item.internal_sku, item.id]));
  const identifiers: Array<{product_id:string; identifier_type:string; value:string; counterparty_id:string|null; is_primary:boolean}> = [];
  uniqueRows.forEach((row) => {
    const productId = idsBySku.get(row.internalSku);
    if (!productId) return;
    if (row.supplierSku) identifiers.push({ product_id: productId, identifier_type: "supplier_sku", value: row.supplierSku, counterparty_id: row.manufacturerId, is_primary: true });
    if (row.gtin) identifiers.push({ product_id: productId, identifier_type: "gtin", value: row.gtin, counterparty_id: null, is_primary: true });
    if (row.unitBarcode) identifiers.push({ product_id: productId, identifier_type: "unit_barcode", value: row.unitBarcode, counterparty_id: null, is_primary: false });
    if (row.boxBarcode) identifiers.push({ product_id: productId, identifier_type: "box_barcode", value: row.boxBarcode, counterparty_id: null, is_primary: false });
  });
  if (identifiers.length) {
    const { error: identifierError } = await supabase.from("product_identifiers").insert(identifiers);
    if (identifierError) go("error", `Создано товаров: ${inserted.length}, но часть идентификаторов не записана: ${identifierError.message}`);
  }
  revalidatePath("/products");
  go("success", `Импортировано товаров: ${inserted.length}${skipped ? `. Пропущено дублей: ${skipped}` : ""}.`);
}
