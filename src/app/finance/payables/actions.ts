"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function uuid(data: FormData, key: string) { const value = text(data, key); if (!uuidPattern.test(value)) throw new Error(`Некорректное поле: ${key}`); return value; }
function day(data: FormData, key: string) { const value = text(data, key); return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; }
function amount(data: FormData, key: string) {
  const raw = text(data, key).replace(/[\s ]/g, "").replace(",", ".");
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;
}
/** The payee card; "none" is the card of expenses without a payee. */
function cardUrl(data: FormData, type: "error" | "success", message: string) {
  const payee = text(data, "payee");
  const target = payee === "none" || uuidPattern.test(payee) ? payee : "none";
  return `/finance/payables/${target}?${type}=${encodeURIComponent(message)}`;
}

export async function recordExpensePayment(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("record_expense_payment", {
    p_request_id: uuid(data, "request_id"), p_expense_id: uuid(data, "expense_id"), p_amount: amount(data, "amount"),
    p_paid_on: day(data, "paid_on"), p_document_id: null, p_note: text(data, "note") || null,
  });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось внести оплату.")));
  revalidatePath("/finance/payables");
  redirect(cardUrl(data, "success", "Оплата внесена. Когда расход оплачен полностью, он переходит в «Оплачен»."));
}

export async function setExpenseDueDate(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_expense_due_date", { p_expense_id: uuid(data, "expense_id"), p_due_date: day(data, "due_date") });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось изменить срок оплаты.")));
  revalidatePath("/finance/payables");
  redirect(cardUrl(data, "success", "Срок оплаты сохранён."));
}

/** An advance to a payee before the expense exists in Nexus (202611170700). */
export async function recordAdvancePayment(data: FormData) {
  const { supabase } = await requireUser();
  const purpose = text(data, "advance_for");
  const { error } = await supabase.rpc("record_advance_payment", {
    p_request_id: uuid(data, "request_id"), p_payee_id: uuid(data, "payee_id"), p_currency_id: uuid(data, "currency_id"),
    p_amount: amount(data, "amount"), p_paid_on: day(data, "paid_on"), p_advance_for: purpose === "goods" ? "goods" : "services",
    p_document_id: null, p_note: text(data, "note") || null,
  });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось внести аванс.")));
  revalidatePath("/finance/payables");
  redirect(cardUrl(data, "success", "Аванс внесён. Зачтите его в расход, когда расход появится в Nexus."));
}

/** Sets an advance off against an expense of the same payee and currency. */
export async function applyAdvance(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("apply_advance", {
    p_request_id: uuid(data, "request_id"), p_payment_id: uuid(data, "advance_id"), p_expense_id: uuid(data, "expense_id"), p_amount: amount(data, "amount"),
  });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось зачесть аванс.")));
  revalidatePath("/finance/payables");
  redirect(cardUrl(data, "success", "Аванс зачтён в расход."));
}
