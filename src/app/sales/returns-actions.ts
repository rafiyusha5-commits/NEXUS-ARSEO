"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import { parseReturnLines } from "@/lib/sales/returns";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value = (formData: FormData, key: string) => { const raw = formData.get(key); return typeof raw === "string" ? raw.trim() : ""; };
const back = (saleId: string, kind: "error" | "success", message: string): never =>
  redirect(`/sales/${saleId}?tab=returns&${kind}=${encodeURIComponent(message)}`);
function refresh(saleId: string) {
  revalidatePath(`/sales/${saleId}`); revalidatePath("/sales/returns"); revalidatePath("/inventory");
}

export async function createCustomerReturnAction(formData: FormData) {
  const saleId = value(formData, "sale_id");
  if (!UUID.test(saleId)) redirect("/sales?error=Некорректный заказ");
  let lines: ReturnType<typeof parseReturnLines> = [];
  try { lines = parseReturnLines(formData.entries()); }
  catch (error) { back(saleId, "error", error instanceof Error ? error.message : "Проверьте количества"); }
  if (!lines.length) back(saleId, "error", "Укажите количество хотя бы по одной партии");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("create_customer_return", { p_sale_id: saleId, p_lines: lines, p_reason: value(formData, "reason") || null });
  if (error) back(saleId, "error", ruleViolationMessage(error, "Не удалось оформить возврат."));
  refresh(saleId);
  back(saleId, "success", "Возврат оформлен. Товар в карантине до решения по каждой позиции.");
}

export async function decideReturnItemAction(formData: FormData) {
  const saleId = value(formData, "sale_id");
  const itemId = value(formData, "item_id");
  const locationId = value(formData, "location_id");
  if (!UUID.test(saleId) || !UUID.test(itemId) || (locationId && !UUID.test(locationId))) redirect("/sales?error=Некорректные данные");
  const decision = value(formData, "decision");
  if (!["restock", "write_off", "return_to_supplier"].includes(decision)) back(saleId, "error", "Выберите решение");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("decide_customer_return_item", { p_item_id: itemId, p_decision: decision, p_location_id: locationId || null, p_note: value(formData, "note") || null });
  if (error) back(saleId, "error", ruleViolationMessage(error, "Не удалось принять решение по возврату."));
  refresh(saleId);
  back(saleId, "success", decision === "restock" ? "Товар возвращён в продажу" : "Решение по возврату записано");
}

export async function cancelCustomerReturnAction(formData: FormData) {
  const saleId = value(formData, "sale_id");
  const returnId = value(formData, "return_id");
  if (!UUID.test(saleId) || !UUID.test(returnId)) redirect("/sales?error=Некорректные данные");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("cancel_customer_return", { p_return_id: returnId, p_reason: value(formData, "reason") });
  if (error) back(saleId, "error", ruleViolationMessage(error, "Не удалось отменить возврат."));
  refresh(saleId);
  back(saleId, "success", "Возврат отменён");
}
