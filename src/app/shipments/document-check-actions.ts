"use server";

import { documentActionReturn } from "@/lib/agent/shipment-workflow";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { findingTaskDescription, findingTaskTitle, parseDocumentCheck } from "@/lib/document-check/rules";
import { ruleViolationMessage } from "@/lib/errors/public-message";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value = (formData: FormData, key: string) => {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
};
const back = (form: FormData, kind: "error" | "success", message: string) =>
  documentActionReturn(form, value(form, "shipment_id"), kind, message, "check");

// Runs the agent now. The database checks the rights and sends notifications only about new problems.
export async function runDocumentCheckAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  if (!UUID.test(shipmentId)) redirect("/shipments?error=Некорректная поставка");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("run_shipment_document_check", { p_shipment_id: shipmentId, p_source: "manual" });
  if (error) redirect(back(formData, "error", ruleViolationMessage(error, "«Сверка» не выполнена.")));
  revalidatePath(`/shipments/${shipmentId}`); revalidatePath(`/assistant/shipments/${shipmentId}`);
  redirect(back(formData, "success", "«Сверка» выполнена"));
}

// A task is created only by this button, for the employee who pressed it. The text is taken from the
// current check in the database, not from the form, so the form cannot put arbitrary text into a task.
export async function createDocumentCheckTaskAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const key = value(formData, "finding_key");
  if (!UUID.test(shipmentId) || !key || key.length > 400) redirect("/shipments?error=Некорректные данные");
  const { supabase, user } = await requireUser();
  const permissions = await loadPermissions(supabase, ["tasks.create"] as const);
  if (!permissions["tasks.create"]) redirect(back(formData, "error", "Недостаточно прав для создания задачи"));

  const [{ data: check, error: checkError }, { data: shipment }] = await Promise.all([
    supabase.rpc("shipment_document_check", { p_shipment_id: shipmentId }),
    supabase.from("shipments").select("shipment_number").eq("id", shipmentId).maybeSingle(),
  ]);
  if (checkError || !shipment) redirect(back(formData, "error", "Не удалось прочитать результат «Сверки»"));
  const finding = parseDocumentCheck(check).findings.find((item) => item.key === key);
  if (!finding) redirect(back(formData, "error", "Это замечание уже устранено"));

  const { error } = await supabase.rpc("create_task", {
    p_title: findingTaskTitle(finding, shipment.shipment_number as string),
    p_assignee_user_id: user.id,
    p_due_at: null,
    p_priority: finding.severity === "error" ? "high" : "normal",
    p_description: findingTaskDescription(finding),
    p_shipment_id: shipmentId,
    p_stage_run_id: null,
  });
  if (error) redirect(back(formData, "error", ruleViolationMessage(error, "Не удалось создать задачу.")));
  revalidatePath("/tasks");
  redirect(back(formData, "success", "Задача создана и назначена вам"));
}
