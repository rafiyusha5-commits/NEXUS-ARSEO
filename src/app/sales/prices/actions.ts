"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function uuid(data: FormData, key: string) { const value = text(data, key); if (!uuidPattern.test(value)) throw new Error(`Некорректное поле: ${key}`); return value; }
function date(data: FormData, key: string) { const value = text(data, key); return datePattern.test(value) ? value : null; }
/** Price or percent as typed: "1 200,50" → 1200.5; empty → null (ends a condition). */
function decimal(data: FormData, key: string) {
  const raw = text(data, key).replace(/[\s ]/g, "").replace(",", ".");
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Некорректное число: ${key}`);
  return value;
}
function pricesUrl(tab: string, type: "error" | "success", message: string, extra = "") {
  return `/sales/prices?tab=${tab}${extra}&${type}=${encodeURIComponent(message)}`;
}
function customerUrl(id: string, type: "error" | "success", message: string) {
  return `/counterparties/${id}?tab=prices&${type}=${encodeURIComponent(message)}`;
}

/** Applies the previewed calculator prices; every conflict carries the decision chosen on the page. */
export async function confirmPriceListImport(data: FormData) {
  const { supabase } = await requireUser();
  const decisions: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    if (key.startsWith("decision:") && (value === "take_sheet" || value === "keep_manual")) decisions[key.slice("decision:".length)] = value;
  }
  const validFrom = date(data, "valid_from");
  const { error } = await supabase.rpc("confirm_price_list_import", {
    p_request_id: uuid(data, "request_id"), p_stamp: text(data, "stamp"), p_valid_from: validFrom, p_decisions: decisions,
  });
  if (error) redirect(pricesUrl("import", "error", ruleViolationMessage(error, "Не удалось загрузить цены.")));
  revalidatePath("/sales/prices");
  redirect(pricesUrl("list", "success", "Цены из калькулятора загружены. Прежние цены остались в истории."));
}

export async function setPriceListPrice(data: FormData) {
  const { supabase } = await requireUser();
  const product = uuid(data, "product_id");
  const { error } = await supabase.rpc("set_price_list_price", {
    p_request_id: uuid(data, "request_id"), p_price_type_id: uuid(data, "price_type_id"), p_product_id: product,
    p_price: decimal(data, "price"), p_valid_from: date(data, "valid_from"), p_reason: text(data, "reason"),
  });
  if (error) redirect(pricesUrl("list", "error", ruleViolationMessage(error, "Не удалось изменить цену."), `&product=${product}`));
  revalidatePath("/sales/prices");
  redirect(pricesUrl("list", "success", "Цена изменена. Следующая загрузка из калькулятора её не перезапишет без вашего решения.", `&product=${product}`));
}

export async function saveBrand(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("save_brand", { p_name: text(data, "name") });
  if (error) redirect(pricesUrl("brands", "error", ruleViolationMessage(error, "Не удалось добавить бренд.")));
  revalidatePath("/sales/prices");
  redirect(pricesUrl("brands", "success", "Бренд добавлен в справочник. Карточки товаров не менялись."));
}

export async function setVatRate(data: FormData) {
  const { supabase } = await requireUser();
  const percent = decimal(data, "rate_percent");
  const { error } = await supabase.rpc("set_vat_rate", {
    p_country: text(data, "country").toUpperCase(), p_rate: percent == null ? null : percent / 100,
    p_valid_from: date(data, "valid_from"), p_reason: text(data, "reason"),
  });
  if (error) redirect(pricesUrl("vat", "error", ruleViolationMessage(error, "Не удалось сохранить ставку НДС.")));
  revalidatePath("/sales/prices");
  redirect(pricesUrl("vat", "success", "Ставка НДС сохранена с датой начала действия."));
}

export async function setCustomerPriceTerms(data: FormData) {
  const { supabase } = await requireUser();
  const customer = uuid(data, "customer_id");
  const { error } = await supabase.rpc("set_customer_price_terms", {
    p_customer_id: customer, p_price_type_id: uuid(data, "price_type_id"), p_contract_currency_id: uuid(data, "currency_id"),
    p_valid_from: date(data, "valid_from"), p_reason: text(data, "reason"),
  });
  if (error) redirect(customerUrl(customer, "error", ruleViolationMessage(error, "Не удалось сохранить условия.")));
  revalidatePath(`/counterparties/${customer}`);
  redirect(customerUrl(customer, "success", "Вид цены и валюта контракта сохранены."));
}

export async function setCustomerBrandMarkup(data: FormData) {
  const { supabase } = await requireUser();
  const customer = uuid(data, "customer_id");
  const { error } = await supabase.rpc("set_customer_brand_markup", {
    p_customer_id: customer, p_brand_id: uuid(data, "brand_id"), p_percent: decimal(data, "percent"),
    p_valid_from: date(data, "valid_from"), p_reason: text(data, "reason"),
  });
  if (error) redirect(customerUrl(customer, "error", ruleViolationMessage(error, "Не удалось сохранить процент.")));
  revalidatePath(`/counterparties/${customer}`);
  redirect(customerUrl(customer, "success", "Условие по бренду сохранено."));
}

export async function setCustomerFixedPrice(data: FormData) {
  const { supabase } = await requireUser();
  const customer = uuid(data, "customer_id");
  const sku = text(data, "sku");
  const { data: product } = await supabase.from("products").select("id").eq("internal_sku", sku).maybeSingle();
  if (!product) redirect(customerUrl(customer, "error", "Товар с таким артикулом не найден."));
  const { error } = await supabase.rpc("set_customer_fixed_price", {
    p_customer_id: customer, p_product_id: product.id, p_price: decimal(data, "price"), p_currency_id: uuid(data, "currency_id"),
    p_valid_from: date(data, "valid_from"), p_reason: text(data, "reason"),
  });
  if (error) redirect(customerUrl(customer, "error", ruleViolationMessage(error, "Не удалось сохранить цену.")));
  revalidatePath(`/counterparties/${customer}`);
  redirect(customerUrl(customer, "success", "Фиксированная цена сохранена."));
}
