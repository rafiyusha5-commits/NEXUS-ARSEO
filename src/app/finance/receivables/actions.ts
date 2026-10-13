"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import { normalizeBankPayments } from "@/lib/finance/bank-statement";
import { normalizeOpeningRows } from "@/lib/finance/opening-balances";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const value = (formData: FormData, key: string) => { const raw = formData.get(key); return typeof raw === "string" ? raw.trim() : ""; };
const go = (path: string, kind: "error" | "success", message: string): never =>
  redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(message)}`);
const amount = (raw: string) => { const parsed = Number(raw.replace(/\s/g, "").replace(",", ".")); return raw && Number.isFinite(parsed) ? parsed : null; };
function refresh(customerId?: string) {
  revalidatePath("/finance/receivables"); revalidatePath("/finance/bank");
  if (customerId) revalidatePath(`/finance/receivables/${customerId}`);
}
function parseJson(raw: string) {
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

export async function importBankStatementAction(formData: FormData) {
  const sha = value(formData, "file_sha256").toLowerCase();
  const fileName = value(formData, "file_name");
  const currency = value(formData, "currency").toUpperCase() || "KZT";
  const periodFrom = value(formData, "period_from"), periodTo = value(formData, "period_to");
  if (!/^[0-9a-f]{64}$/.test(sha) || !fileName || !/^[A-Z]{3}$/.test(currency)) go("/finance/bank", "error", "Выберите файл выписки заново");
  let lines: ReturnType<typeof normalizeBankPayments> = [];
  try { lines = normalizeBankPayments(parseJson(value(formData, "payments"))); }
  catch (error) { go("/finance/bank", "error", error instanceof Error ? error.message : "Некорректная выписка"); }
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("import_bank_statement", {
    p_file_name: fileName.slice(0, 255), p_file_sha256: sha, p_account: value(formData, "account") || null,
    p_period_from: DATE.test(periodFrom) ? periodFrom : null, p_period_to: DATE.test(periodTo) ? periodTo : null,
    p_currency: currency, p_lines: lines,
  });
  if (error) go("/finance/bank", "error", ruleViolationMessage(error, "Не удалось загрузить выписку."));
  const result = (data ?? {}) as { new?: number; duplicates?: number; matched?: number };
  refresh();
  go("/finance/bank", "success", `Загружено поступлений: ${result.new ?? 0}, разнесено автоматически: ${result.matched ?? 0}` +
    (result.duplicates ? `, уже были в прошлых выписках: ${result.duplicates}` : ""));
}

export async function resolveBankLineAction(formData: FormData) {
  const lineId = value(formData, "line_id");
  const action = value(formData, "action");
  const customerId = value(formData, "customer_id");
  if (!UUID.test(lineId) || !["match", "ignore", "reset"].includes(action) || (customerId && !UUID.test(customerId))) {
    go("/finance/bank", "error", "Некорректные данные");
  }
  if (action === "match" && !customerId) go("/finance/bank", "error", "Выберите покупателя");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("resolve_bank_line", {
    p_line_id: lineId, p_action: action, p_customer_id: action === "match" ? customerId : null, p_sale_id: null, p_note: value(formData, "note") || null,
  });
  if (error) go("/finance/bank", "error", ruleViolationMessage(error, "Не удалось разнести платёж."));
  refresh(customerId || undefined);
  go("/finance/bank", "success", action === "match" ? "Платёж разнесён" : action === "ignore" ? "Платёж отмечен как не относящийся к покупателям" : "Платёж возвращён в неразнесённые");
}

export async function importOpeningBalancesAction(formData: FormData) {
  const asOf = value(formData, "as_of");
  if (!DATE.test(asOf)) go("/finance/receivables", "error", "Укажите дату сальдо");
  let rows: ReturnType<typeof normalizeOpeningRows> = [];
  try { rows = normalizeOpeningRows(parseJson(value(formData, "rows"))); }
  catch (error) { go("/finance/receivables", "error", error instanceof Error ? error.message : "Некорректный отчёт"); }
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("import_opening_balances", { p_as_of: asOf, p_rows: rows, p_file_name: value(formData, "file_name").slice(0, 255) || null });
  if (error) go("/finance/receivables", "error", ruleViolationMessage(error, "Не удалось загрузить сальдо."));
  const result = (data ?? {}) as { applied?: number; unmatched?: { row: number; name: string | null; bin: string | null }[] };
  refresh();
  const unmatched = result.unmatched ?? [];
  const missing = unmatched.slice(0, 5).map(row => row.name || row.bin || `строка ${row.row}`).join("; ");
  if (unmatched.length) go("/finance/receivables", "error", `Сальдо загружено по ${result.applied ?? 0} покупателям. Не найдены в справочнике (${unmatched.length}): ${missing}${unmatched.length > 5 ? "…" : ""}. Добавьте их и загрузите отчёт ещё раз.`);
  go("/finance/receivables", "success", `Сальдо загружено по ${result.applied ?? 0} покупателям`);
}

export async function setCreditTermsAction(formData: FormData) {
  const customerId = value(formData, "customer_id");
  if (!UUID.test(customerId)) go("/finance/receivables", "error", "Некорректный покупатель");
  const path = `/finance/receivables/${customerId}`;
  const limitRaw = value(formData, "credit_limit"), daysRaw = value(formData, "default_deferral_days");
  const limit = limitRaw ? amount(limitRaw) : null;
  const days = daysRaw ? Number(daysRaw) : null;
  if ((limitRaw && limit === null) || (daysRaw && !Number.isInteger(days))) go(path, "error", "Проверьте лимит и отсрочку");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("set_customer_credit_terms", {
    p_customer_id: customerId, p_credit_limit: limit, p_limit_currency: limit === null ? null : value(formData, "limit_currency") || null, p_default_deferral_days: days,
  });
  if (error) go(path, "error", ruleViolationMessage(error, "Не удалось сохранить условия."));
  refresh(customerId);
  go(path, "success", "Условия оплаты сохранены");
}

export async function addAdjustmentAction(formData: FormData) {
  const customerId = value(formData, "customer_id");
  if (!UUID.test(customerId)) go("/finance/receivables", "error", "Некорректный покупатель");
  const path = `/finance/receivables/${customerId}`;
  const sum = amount(value(formData, "amount"));
  const date = value(formData, "entry_date");
  if (sum === null || !DATE.test(date)) go(path, "error", "Укажите сумму и дату корректировки");
  const signed = value(formData, "direction") === "decrease" ? -Math.abs(sum!) : Math.abs(sum!);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("add_customer_balance_adjustment", {
    p_customer_id: customerId, p_currency: value(formData, "currency") || "KZT", p_entry_date: date, p_amount: signed, p_reason: value(formData, "reason"),
  });
  if (error) go(path, "error", ruleViolationMessage(error, "Не удалось записать корректировку."));
  refresh(customerId);
  go(path, "success", "Корректировка записана");
}

export async function recordActAction(formData: FormData) {
  const customerId = value(formData, "customer_id");
  if (!UUID.test(customerId)) go("/finance/receivables", "error", "Некорректный покупатель");
  const path = `/finance/receivables/${customerId}`;
  const balance = amount(value(formData, "act_balance"));
  const date = value(formData, "as_of");
  if (balance === null || !DATE.test(date)) go(path, "error", "Укажите дату и сальдо по акту");
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("record_reconciliation_act", {
    p_customer_id: customerId, p_currency: value(formData, "currency") || "KZT", p_as_of: date,
    p_act_balance: value(formData, "side") === "advance" ? -Math.abs(balance!) : balance, p_note: value(formData, "note") || null,
  });
  if (error) go(path, "error", ruleViolationMessage(error, "Не удалось записать акт сверки."));
  const difference = Number((data as { difference?: number } | null)?.difference ?? 0);
  refresh(customerId);
  go(path, difference === 0 ? "success" : "error", difference === 0 ? "Акт сверки совпадает с данными Nexus"
    : `Акт записан. Расхождение с Nexus: ${difference.toLocaleString("ru-RU", { minimumFractionDigits: 2 })}. Найдите причину в журнале ниже.`);
}

export async function recordCreditDecisionAction(formData: FormData) {
  const saleId = value(formData, "sale_id");
  if (!UUID.test(saleId)) redirect("/sales?error=Некорректный заказ");
  const path = `/sales/${saleId}?tab=payment`;
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("record_sale_credit_decision", { p_sale_id: saleId, p_reason: value(formData, "reason") });
  if (error) go(path, "error", ruleViolationMessage(error, "Не удалось записать решение."));
  revalidatePath(`/sales/${saleId}`);
  go(path, "success", "Решение записано, бухгалтерия уведомлена. Теперь заказ можно подтвердить.");
}
