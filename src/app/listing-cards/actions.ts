"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { type CardHeaderInput, parseDecimal, validateCardHeader, validateCardItem } from "@/lib/listing-cards/rules.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function withMessage(path: string, kind: "error" | "success", message: string) {
  return `${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`;
}

function readHeader(formData: FormData): CardHeaderInput {
  return {
    card_type: text(formData, "card_type"),
    counterparty_id: text(formData, "counterparty_id"),
    template_id: text(formData, "template_id") || null,
    title: text(formData, "title") || null,
    effective_date: text(formData, "effective_date") || null,
    notes: text(formData, "notes") || null,
  };
}

function cardPath(formData: FormData) {
  const id = text(formData, "card_id");
  if (!UUID.test(id)) redirect(withMessage("/listing-cards", "error", "Некорректная карта"));
  return { id, back: `/listing-cards/${id}` };
}

function friendly(message: string, code?: string) {
  if (code === "23505") return "Такая запись уже есть (например, товар уже добавлен в карту или у версии уже есть следующая)";
  if (code === "42501" || /row-level security/.test(message)) return "Недостаточно прав или карта уже не является черновиком";
  return publicErrorMessage({ code, message }, "Не удалось выполнить действие с картой ввода.");
}

export async function createCardAction(formData: FormData) {
  const { supabase } = await requireUser();
  const header = readHeader(formData);
  const error = validateCardHeader(header);
  if (error) redirect(withMessage("/listing-cards", "error", error));
  const id = crypto.randomUUID();
  const { error: insertError } = await supabase.from("product_listing_cards").insert({ id, ...header });
  if (insertError) redirect(withMessage("/listing-cards", "error", friendly(insertError.message, insertError.code)));
  revalidatePath("/listing-cards");
  redirect(withMessage(`/listing-cards/${id}`, "success", "Черновик карты создан. Добавьте позиции товаров"));
}

export async function updateCardAction(formData: FormData) {
  const { supabase } = await requireUser();
  const { id, back } = cardPath(formData);
  const header = readHeader(formData);
  const error = validateCardHeader(header);
  if (error) redirect(withMessage(back, "error", error));
  const { data, error: updateError } = await supabase.from("product_listing_cards").update(header).eq("id", id).select("id");
  if (updateError) redirect(withMessage(back, "error", friendly(updateError.message, updateError.code)));
  if (!data?.length) redirect(withMessage(back, "error", "Изменения не сохранены: нет права или карта уже не черновик"));
  revalidatePath(back);
  redirect(withMessage(back, "success", "Карта сохранена"));
}

export async function addCardItemAction(formData: FormData) {
  const { supabase } = await requireUser();
  const { id, back } = cardPath(formData);
  const item = {
    product_id: text(formData, "product_id"),
    required_quantity: parseDecimal(text(formData, "required_quantity")) ?? Number.NaN,
    uom: text(formData, "uom") || "piece",
    counterparty_sku: text(formData, "counterparty_sku") || null,
    price: parseDecimal(text(formData, "price")),
    currency_id: text(formData, "currency_id") || null,
    comment: text(formData, "comment") || null,
  };
  const { data: existing } = await supabase.from("product_listing_card_items").select("product_id").eq("card_id", id);
  const error = validateCardItem(item, (existing ?? []).map((row) => row.product_id as string));
  if (error) redirect(withMessage(back, "error", error));
  const { error: insertError } = await supabase
    .from("product_listing_card_items")
    .insert({ card_id: id, ...item, currency_id: item.price === null ? null : item.currency_id });
  if (insertError) redirect(withMessage(back, "error", friendly(insertError.message, insertError.code)));
  revalidatePath(back);
  redirect(withMessage(back, "success", "Позиция добавлена"));
}

export async function removeCardItemAction(formData: FormData) {
  const { supabase } = await requireUser();
  const { id, back } = cardPath(formData);
  const itemId = text(formData, "item_id");
  if (!UUID.test(itemId)) redirect(withMessage(back, "error", "Некорректная позиция"));
  const { data, error } = await supabase.from("product_listing_card_items").delete().eq("id", itemId).eq("card_id", id).select("id");
  if (error) redirect(withMessage(back, "error", friendly(error.message, error.code)));
  if (!data?.length) redirect(withMessage(back, "error", "Позиция не удалена: нет права или карта уже не черновик"));
  revalidatePath(back);
  redirect(withMessage(back, "success", "Позиция удалена из черновика"));
}

async function callCardRpc(formData: FormData, rpc: string, args: Record<string, unknown>, success: string) {
  const { supabase } = await requireUser();
  const { id, back } = cardPath(formData);
  const { error } = await supabase.rpc(rpc, { p_card_id: id, ...args });
  if (error) redirect(withMessage(back, "error", friendly(error.message, error.code)));
  revalidatePath(back);
  revalidatePath("/listing-cards");
  redirect(withMessage(back, "success", success));
}

export async function submitCardAction(formData: FormData) {
  await callCardRpc(formData, "submit_listing_card", {}, "Карта отправлена контрагенту и больше не редактируется");
}

export async function decideCardAction(formData: FormData) {
  const decision = text(formData, "decision");
  if (decision !== "approved" && decision !== "rejected") {
    redirect(withMessage(cardPath(formData).back, "error", "Выберите решение контрагента"));
  }
  await callCardRpc(
    formData,
    "record_listing_card_decision",
    { p_decision: decision, p_comment: text(formData, "comment") || null },
    decision === "approved" ? "Решение контрагента зафиксировано: карта утверждена" : "Решение контрагента зафиксировано: карта отклонена",
  );
}

export async function cancelCardAction(formData: FormData) {
  await callCardRpc(formData, "cancel_listing_card", { p_reason: text(formData, "reason") }, "Карта отменена");
}

export async function createCardVersionAction(formData: FormData) {
  const { supabase } = await requireUser();
  const { back } = cardPath(formData);
  const { data, error } = await supabase.rpc("create_listing_card_version", { p_card_id: cardPath(formData).id });
  if (error || typeof data !== "string") redirect(withMessage(back, "error", friendly(error?.message ?? "Не удалось создать версию", error?.code)));
  revalidatePath(back);
  revalidatePath("/listing-cards");
  redirect(withMessage(`/listing-cards/${data}`, "success", "Создана новая версия-черновик. Позиции скопированы из предыдущей версии"));
}
