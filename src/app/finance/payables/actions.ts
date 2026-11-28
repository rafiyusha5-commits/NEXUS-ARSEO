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

/** "Планируем оплатить" (202611280200): the date the payment calendar uses instead of the due date; an empty date returns to it. */
export async function setExpensePlannedPaymentDate(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_expense_planned_payment_date", {
    p_expense_id: uuid(data, "expense_id"), p_date: day(data, "planned_payment_date"), p_reason: text(data, "reason"),
  });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось изменить плановую дату оплаты.")));
  revalidatePath("/finance/payables");
  revalidatePath("/finance/cash");
  redirect(cardUrl(data, "success", "Плановая дата оплаты сохранена. Платёжный календарь учитывает её вместо срока."));
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

/** Money the payee returned: closes an overpayment of a reversed expense or the unused rest of an advance (202611210200). */
export async function recordPaymentRefund(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("record_payment_refund", {
    p_request_id: uuid(data, "request_id"), p_payment_id: uuid(data, "payment_id"), p_amount: amount(data, "amount"),
    p_received_on: day(data, "received_on"), p_document_id: null, p_note: text(data, "note") || null,
  });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось записать возврат.")));
  revalidatePath("/finance/payables");
  redirect(cardUrl(data, "success", "Возврат денег от получателя записан."));
}

/** Sets an advance or an overpayment off against an expense of the same payee, currency and kind. */
export async function applyAdvance(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("apply_advance", {
    p_request_id: uuid(data, "request_id"), p_payment_id: uuid(data, "advance_id"), p_expense_id: uuid(data, "expense_id"), p_amount: amount(data, "amount"),
  });
  if (error) redirect(cardUrl(data, "error", ruleViolationMessage(error, "Не удалось зачесть аванс или переплату.")));
  revalidatePath("/finance/payables");
  redirect(cardUrl(data, "success", "Зачтено в расход."));
}
