"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { TASK_PRIORITIES, TASK_STATUSES, localInputToIso } from "@/lib/tasks/rules.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function optionalUuid(formData: FormData, name: string): string | null {
  const value = text(formData, name);
  return UUID.test(value) ? value : null;
}

// Back to the list with the same filters; only /tasks URLs are accepted.
function back(formData: FormData, kind: "error" | "success", message: string): never {
  const raw = text(formData, "return_to");
  const url = new URL(raw.startsWith("/tasks") && !raw.startsWith("//") ? raw : "/tasks", "http://nexus.local");
  url.searchParams.delete("error");
  url.searchParams.delete("success");
  url.searchParams.set(kind, message);
  redirect(`${url.pathname}${url.search}`);
}

function refresh() {
  revalidatePath("/tasks");
  revalidatePath("/notifications");
  // The unread counter lives in the sidebar of every page.
  revalidatePath("/", "layout");
}

export async function createTaskAction(formData: FormData) {
  const { profile, supabase } = await requireUser();
  const title = text(formData, "title");
  if (!title) back(formData, "error", "Укажите название задачи.");
  const dueInput = text(formData, "due_at");
  const dueAt = dueInput ? localInputToIso(dueInput) : null;
  if (dueInput && !dueAt) back(formData, "error", "Некорректный срок.");
  const priority = text(formData, "priority") || "normal";
  if (!(TASK_PRIORITIES as readonly string[]).includes(priority)) back(formData, "error", "Некорректный приоритет.");

  const { error } = await supabase.rpc("create_task", {
    p_title: title,
    p_assignee_user_id: optionalUuid(formData, "assignee_user_id") ?? profile.id,
    p_due_at: dueAt,
    p_priority: priority,
    p_description: text(formData, "description") || null,
    p_shipment_id: optionalUuid(formData, "shipment_id"),
    p_stage_run_id: optionalUuid(formData, "stage_run_id"),
  });
  if (error) back(formData, "error", publicErrorMessage(error, "Не удалось создать задачу."));
  refresh();
  back(formData, "success", "Задача создана.");
}

export async function setTaskStatusAction(formData: FormData) {
  const { supabase } = await requireUser();
  const taskId = optionalUuid(formData, "task_id");
  const status = text(formData, "status");
  if (!taskId || !(TASK_STATUSES as readonly string[]).includes(status)) back(formData, "error", "Некорректная задача или статус.");
  const { error } = await supabase.rpc("set_task_status", { p_task_id: taskId, p_status: status });
  if (error) back(formData, "error", publicErrorMessage(error, "Не удалось изменить статус задачи."));
  refresh();
  back(formData, "success", status === "done" ? "Задача завершена." : status === "in_progress" ? "Задача взята в работу." : "Статус задачи изменён.");
}

export async function reassignTaskAction(formData: FormData) {
  const { supabase } = await requireUser();
  const taskId = optionalUuid(formData, "task_id");
  const assignee = optionalUuid(formData, "assignee_user_id");
  if (!taskId || !assignee) back(formData, "error", "Выберите нового исполнителя.");
  const { error } = await supabase.rpc("reassign_task", { p_task_id: taskId, p_assignee_user_id: assignee });
  if (error) back(formData, "error", publicErrorMessage(error, "Не удалось изменить исполнителя."));
  refresh();
  back(formData, "success", "Исполнитель изменён. Сотрудники получили уведомления.");
}

export async function changeTaskDueAction(formData: FormData) {
  const { supabase } = await requireUser();
  const taskId = optionalUuid(formData, "task_id");
  if (!taskId) back(formData, "error", "Некорректная задача.");
  const dueInput = text(formData, "due_at");
  const dueAt = dueInput ? localInputToIso(dueInput) : null;
  if (dueInput && !dueAt) back(formData, "error", "Некорректный срок.");
  const { error } = await supabase.rpc("change_task_due", { p_task_id: taskId, p_due_at: dueAt });
  if (error) back(formData, "error", publicErrorMessage(error, "Не удалось изменить срок задачи."));
  refresh();
  back(formData, "success", dueAt ? "Срок изменён." : "Срок снят.");
}
