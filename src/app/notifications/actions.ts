"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { notificationLink } from "@/lib/notifications/rules.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function go(kind: "error" | "success", message: string): never {
  redirect(`/notifications?${kind}=${encodeURIComponent(message)}`);
}

function refresh() {
  revalidatePath("/notifications");
  // The unread counter lives in the sidebar of every page.
  revalidatePath("/", "layout");
}

function notificationId(formData: FormData): string {
  const value = formData.get("notification_id");
  if (typeof value !== "string" || !UUID.test(value)) go("error", "Некорректное уведомление.");
  return value;
}

export async function markNotificationReadAction(formData: FormData) {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("mark_notification_read", { p_notification_id: notificationId(formData) });
  if (error) go("error", error.message);
  refresh();
  go("success", "Уведомление отмечено прочитанным.");
}

export async function markAllNotificationsReadAction() {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("mark_all_notifications_read");
  if (error) go("error", error.message);
  refresh();
  go("success", data ? `Отмечено прочитанными: ${data}.` : "Непрочитанных уведомлений нет.");
}

// Marks the notification read and opens its target. The link is built from the stored
// notification (read under RLS), never from the form, so it cannot lead elsewhere.
export async function openNotificationAction(formData: FormData) {
  const { supabase } = await requireUser();
  const id = notificationId(formData);
  const { data, error } = await supabase
    .from("notifications")
    .select("id, is_read, entity_type, entity_id, shipment_id")
    .eq("id", id)
    .maybeSingle();
  if (error || !data) go("error", "Уведомление не найдено.");
  if (!data.is_read) {
    const { error: readError } = await supabase.rpc("mark_notification_read", { p_notification_id: id });
    if (readError) go("error", readError.message);
    refresh();
  }
  const link = notificationLink(data);
  if (!link) go("success", "Уведомление отмечено прочитанным. Связанный объект недоступен.");
  redirect(link.href);
}
