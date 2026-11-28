"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// Accounts, balances and the gap warning of the payment calendar (202611280200). The database checks finance.manage.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function uuid(data: FormData, key: string) { const value = text(data, key); if (!uuidPattern.test(value)) throw new Error(`Некорректное поле: ${key}`); return value; }
function day(data: FormData, key: string) { const value = text(data, key); return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; }
function amount(data: FormData, key: string) {
  const raw = text(data, key).replace(/[\s ]/g, "").replace(",", ".");
  const value = Number(raw);
  return raw && Number.isFinite(value) ? value : null;
}
function back(type: "error" | "success", message: string): never {
  redirect(`/finance/cash?${type}=${encodeURIComponent(message)}#accounts`);
}

export async function saveCashAccount(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("save_cash_account", { p_name: text(data, "name"), p_bank: text(data, "bank") || null, p_currency_id: uuid(data, "currency_id") });
  if (error) back("error", ruleViolationMessage(error, "Не удалось сохранить счёт."));
  revalidatePath("/finance/cash");
  back("success", "Счёт сохранён. Введите его остаток, чтобы календарь начинался с него.");
}

export async function recordCashBalance(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("record_cash_balance", {
    p_account_id: uuid(data, "account_id"), p_as_of: day(data, "as_of"), p_amount: amount(data, "amount"), p_note: text(data, "note") || null,
  });
  if (error) back("error", ruleViolationMessage(error, "Не удалось записать остаток."));
  revalidatePath("/finance/cash");
  back("success", "Остаток записан. Прежние остатки сохраняются в истории счёта.");
}

export async function setCashAccountActive(data: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_cash_account_active", { p_account_id: uuid(data, "account_id"), p_active: text(data, "active") === "true" });
  if (error) back("error", ruleViolationMessage(error, "Не удалось изменить счёт."));
  revalidatePath("/finance/cash");
  back("success", text(data, "active") === "true" ? "Счёт снова учитывается." : "Счёт закрыт: его остаток больше не учитывается.");
}

export async function setCashGapAlertDays(data: FormData) {
  const { supabase } = await requireUser();
  const days = Number(text(data, "days"));
  const { error } = await supabase.rpc("set_cash_gap_alert_days", { p_days: Number.isInteger(days) ? days : null });
  if (error) back("error", ruleViolationMessage(error, "Не удалось сохранить настройку."));
  revalidatePath("/finance/cash");
  back("success", "Настройка сохранена: уведомление придёт, если разрыв ожидается в эти дни.");
}
