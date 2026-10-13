"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage, ruleViolationMessage } from "@/lib/errors/public-message";
import { acceptMessage, safeReturnPath } from "@/lib/logist/proposals";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value = (formData: FormData, key: string) => { const raw = formData.get(key); return typeof raw === "string" ? raw.trim() : ""; };
// The shipment card shows its usual error and success notices; the Logist page has its own.
function back(path: string, kind: "error" | "success", message: string): never {
  const [base, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  const prefix = base.startsWith("/shipments/") ? "" : "logist_";
  for (const name of ["error", "success"]) params.delete(`${prefix}${name}`);
  params.set(`${prefix}${kind}`, message);
  redirect(`${base}?${params.toString()}#logist`);
}
function refresh(shipmentId: string) {
  revalidatePath("/logist");
  if (UUID.test(shipmentId)) revalidatePath(`/shipments/${shipmentId}`);
}

export async function runLogistAction(formData: FormData) {
  const path = safeReturnPath(value(formData, "back"));
  const shipmentId = value(formData, "shipment_id");
  if (shipmentId && !UUID.test(shipmentId)) back(path, "error", "Некорректная поставка");
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("run_logist", { p_shipment_id: shipmentId || null });
  if (error) back(path, "error", publicErrorMessage(error, "Логист не смог проверить поставки."));
  refresh(shipmentId);
  const result = data as { new?: number; pending?: number } | null;
  back(path, "success", result?.new ? `Новых предложений: ${result.new}. Ждут решения: ${result.pending ?? 0}.` : `Новых предложений нет. Ждут решения: ${result?.pending ?? 0}.`);
}

export async function acceptLogistProposalAction(formData: FormData) {
  const path = safeReturnPath(value(formData, "back"));
  const proposalId = value(formData, "proposal_id");
  if (!UUID.test(proposalId)) back(path, "error", "Некорректное предложение");
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("accept_logist_proposal", { p_proposal_id: proposalId });
  if (error) back(path, "error", ruleViolationMessage(error, "Не удалось выполнить предложение."));
  refresh(value(formData, "shipment_id"));
  const message = acceptMessage(data);
  back(path, message.kind, message.text);
}

export async function rejectLogistProposalAction(formData: FormData) {
  const path = safeReturnPath(value(formData, "back"));
  const proposalId = value(formData, "proposal_id");
  if (!UUID.test(proposalId)) back(path, "error", "Некорректное предложение");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("reject_logist_proposal", { p_proposal_id: proposalId, p_note: value(formData, "note") || null });
  if (error) back(path, "error", ruleViolationMessage(error, "Не удалось отклонить предложение."));
  refresh(value(formData, "shipment_id"));
  back(path, "success", "Предложение отклонено. Логист не будет предлагать это снова.");
}
