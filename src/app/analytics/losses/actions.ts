"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASON = /^[a-z][a-z_]{1,39}$/;
const text = (data: FormData, key: string) => { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; };
const back = (kind: "error" | "success", message: string) => `/analytics/losses?view=unclassified&${kind}=${encodeURIComponent(message)}`;

/** Reason of a write-off posted without one: once, with a basis; the database checks the right and keeps the audit record. */
export async function classifyLossReason(data: FormData) {
  const { supabase } = await requireUser();
  const lineId = text(data, "line_id");
  const reason = text(data, "loss_reason_code");
  const basis = text(data, "basis");
  if (!UUID.test(lineId) || !REASON.test(reason)) redirect(back("error", "Выберите причину списания"));
  if (basis.length < 10 || basis.length > 1000) redirect(back("error", "Укажите основание: от 10 до 1000 символов"));
  const { error } = await supabase.rpc("set_inventory_loss_reason", { p_line_id: lineId, p_loss_reason_code: reason, p_basis: basis });
  if (error) redirect(back("error", ruleViolationMessage(error, "Не удалось сохранить причину.")));
  revalidatePath("/analytics/losses");
  redirect(back("success", "Причина сохранена и записана в журнал аудита"));
}
