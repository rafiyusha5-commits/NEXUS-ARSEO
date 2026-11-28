"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import type { BatchRegrades } from "@/lib/inventory/expiry-regrade";

// Regrade by expiry (202611280800): the database checks the right, the free stock, the count lock, the dates and the
// reason; these actions only pass the form and say what to do next with the labels.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
const day = (value: string) => value.split("-").reverse().join(".");

export async function regradeBatchExpiry(data: FormData) {
  const { supabase } = await requireUser();
  const batchId = text(data, "batch_id");
  if (!uuidPattern.test(batchId)) redirect("/inventory");
  const back = (message: string): never => redirect(`/inventory/${batchId}?tab=main&error=${encodeURIComponent(message)}#expiry-regrade`);
  const balanceId = text(data, "balance_id");
  const expiry = text(data, "expiry_date");
  const raw = text(data, "quantity").replace(/[\s ]/g, "").replace(",", ".");
  if (!uuidPattern.test(balanceId)) back("Выберите, где лежит часть с другим сроком");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) back("Укажите правильный срок годности");
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw) || Number(raw) <= 0) back("Укажите количество числом, не более трёх знаков после запятой");
  const { data: id, error } = await supabase.rpc("regrade_batch_expiry", { p_balance_id: balanceId, p_quantity: Number(raw), p_expiry_date: expiry, p_reason: text(data, "reason") });
  if (error) back(ruleViolationMessage(error, "Не удалось исправить срок."));
  const { data: history } = await supabase.rpc("batch_expiry_regrades", { p_batch_id: batchId });
  const done = (history as BatchRegrades | null)?.regrades.find(item => item.id === id);
  revalidatePath("/inventory"); revalidatePath(`/inventory/${batchId}`);
  const target = done?.to_batch_id ?? batchId;
  const { data: batch } = await supabase.from("inventory_batches").select("status").eq("id", target).maybeSingle();
  redirect(`/inventory/${target}?tab=main&success=${encodeURIComponent(`${done?.number ?? "Пересорт"}: ${raw} перенесено в партию до ${day(expiry)}.`
    + ` Напечатайте наклейки этой партии и переклейте коробки.${batch && batch.status !== "available" ? " Партия не доступна к отбору, как исходная: снимите блокировку, когда проверите." : ""}`)}`);
}

export async function cancelExpiryRegrade(data: FormData) {
  const { supabase } = await requireUser();
  const batchId = text(data, "batch_id");
  const id = text(data, "regrade_id");
  if (!uuidPattern.test(batchId) || !uuidPattern.test(id)) redirect("/inventory");
  const { error } = await supabase.rpc("cancel_expiry_regrade", { p_id: id, p_reason: text(data, "reason") });
  const target = `/inventory/${batchId}?tab=main`;
  if (error) redirect(`${target}&error=${encodeURIComponent(ruleViolationMessage(error, "Не удалось отменить пересорт."))}#expiry-regrade`);
  revalidatePath("/inventory"); revalidatePath(`/inventory/${batchId}`);
  redirect(`${target}&success=${encodeURIComponent("Пересорт отменён: количество вернулось в прежнюю партию.")}#expiry-regrade`);
}
