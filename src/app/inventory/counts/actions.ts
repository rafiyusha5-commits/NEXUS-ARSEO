"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// Inventory counts (202611280300). Every rule and right is checked by the database; these actions only pass the form.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function uuid(data: FormData, key: string) { const value = text(data, key); if (!uuidPattern.test(value)) throw new Error(`Некорректное поле: ${key}`); return value; }
function optionalUuid(data: FormData, key: string) { const value = text(data, key); return uuidPattern.test(value) ? value : null; }
function uuids(data: FormData, key: string) { return data.getAll(key).filter((value): value is string => typeof value === "string" && uuidPattern.test(value)); }
function quantity(data: FormData, key: string) {
  const raw = text(data, key).replace(/[\s ]/g, "").replace(",", ".");
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;
}
function card(id: string, type: "error" | "success", message: string, anchor = ""): never {
  redirect(`/inventory/counts/${id}?${type}=${encodeURIComponent(message)}${anchor}`);
}
function refresh(id?: string) {
  revalidatePath("/inventory/counts");
  revalidatePath("/inventory");
  if (id) revalidatePath(`/inventory/counts/${id}`);
}

export async function createInventoryCount(data: FormData) {
  const { supabase } = await requireUser();
  const { data: id, error } = await supabase.rpc("create_inventory_count", {
    p_warehouse_id: uuid(data, "warehouse_id"), p_kind: text(data, "kind") === "full" ? "full" : "partial",
    p_blind: text(data, "blind") !== "false", p_responsible_user_id: optionalUuid(data, "responsible_user_id"), p_note: text(data, "note") || null,
  });
  if (error) redirect(`/inventory/counts?error=${encodeURIComponent(ruleViolationMessage(error, "Не удалось создать инвентаризацию."))}`);
  refresh(String(id));
  card(String(id), "success", text(data, "kind") === "full" ? "Черновик создан. Начните пересчёт, когда склад готов." : "Черновик создан. Задайте состав пересчёта.");
}

export async function setInventoryCountScope(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const zones = data.getAll("zones").filter((value): value is string => typeof value === "string");
  const products = text(data, "product_ids").split(/[\s,]+/).filter(value => uuidPattern.test(value));
  const { error } = await supabase.rpc("set_inventory_count_scope", {
    p_count_id: id, p_location_ids: uuids(data, "location_ids"), p_zones: zones, p_no_location: text(data, "no_location") === "on",
    p_product_ids: [...uuids(data, "products"), ...products],
  });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось сохранить состав."));
  refresh(id);
  card(id, "success", "Состав сохранён.");
}

export async function startInventoryCount(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const { data: rows, error } = await supabase.rpc("start_inventory_count", { p_count_id: id });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось начать пересчёт."));
  refresh(id);
  card(id, "success", `Пересчёт начат: учётный остаток запомнен (${rows} строк), движения по считаемым местам заблокированы.`);
}

export async function recordInventoryCount(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const round = Number(text(data, "round")) === 2 ? 2 : 1;
  const { error } = await supabase.rpc("record_inventory_count", {
    p_count_id: id, p_round: round, p_location_id: optionalUuid(data, "location_id"), p_product_id: uuid(data, "product_id"),
    p_batch_id: optionalUuid(data, "batch_id"), p_uom: text(data, "uom"), p_quantity: quantity(data, "quantity"),
    p_note: text(data, "note") || null, p_supersedes_entry_id: optionalUuid(data, "supersedes_entry_id"),
  });
  const location = text(data, "location_id");
  const keep = `&location=${encodeURIComponent(location || "none")}#count`;
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось записать подсчёт."), keep);
  refresh(id);
  card(id, "success", optionalUuid(data, "supersedes_entry_id") ? "Исправление записано, прежняя запись осталась в истории." : "Подсчёт записан.", keep);
}

export async function finishInventoryCountRound(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const { data: result, error } = await supabase.rpc("finish_inventory_count_round", { p_count_id: id });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось завершить подсчёт."));
  refresh(id);
  const value = result as { status: string; recount_lines: number } | null;
  card(id, "success", value?.status === "recount"
    ? `Подсчёт завершён. Позиций на повторный подсчёт: ${value.recount_lines} — их пересчитывает другой сотрудник.`
    : "Подсчёт завершён, пересчёт передан на утверждение.");
}

export async function setInventoryCountDecision(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const batch = text(data, "assigned_batch_id");
  const { error } = await supabase.rpc("set_inventory_count_decision", {
    p_line_id: uuid(data, "line_id"), p_reason_code: text(data, "reason_code") || null,
    p_assigned_batch_id: uuidPattern.test(batch) ? batch : null, p_ignored: batch === "ignore",
  });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось сохранить решение."), "#review");
  refresh(id);
  card(id, "success", "Решение сохранено.", "#review");
}

export async function pairInventoryCountLines(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const { error } = await supabase.rpc("pair_inventory_count_lines", { p_shortage_line_id: uuid(data, "line_id"), p_surplus_line_id: optionalUuid(data, "pair_line_id") });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось связать строки."), "#review");
  refresh(id);
  card(id, "success", optionalUuid(data, "pair_line_id") ? "Строки связаны как пересорт." : "Связь снята.", "#review");
}

export async function postInventoryCount(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const { error } = await supabase.rpc("post_inventory_count", { p_count_id: id, p_digest: text(data, "digest") });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось провести инвентаризацию."), "#review");
  refresh(id);
  revalidatePath("/inventory/movements");
  card(id, "success", "Инвентаризация проведена: остатки изменены документом корректировки.");
}

export async function cancelInventoryCount(data: FormData) {
  const { supabase } = await requireUser();
  const id = uuid(data, "count_id");
  const { error } = await supabase.rpc("cancel_inventory_count", { p_count_id: id, p_reason: text(data, "reason") });
  if (error) card(id, "error", ruleViolationMessage(error, "Не удалось отменить инвентаризацию."));
  refresh(id);
  revalidatePath("/inventory/movements");
  card(id, "success", "Инвентаризация отменена.");
}

export async function setInventoryCountTolerance(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_inventory_count_tolerance", { p_pieces: quantity(data, "pieces") });
  if (error) redirect(`/inventory/counts?error=${encodeURIComponent(ruleViolationMessage(error, "Не удалось сохранить допуск."))}`);
  refresh();
  redirect(`/inventory/counts?success=${encodeURIComponent("Допуск сохранён: он действует для пересчётов, начатых после этого.")}`);
}
