"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAccessManager } from "@/lib/auth/access";
import { createAdminClient } from "@/lib/supabase/admin";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";
const done = (kind: "error" | "success", message: string): never => redirect(`/admin/client-access?${kind}=${encodeURIComponent(message)}`);

export async function inviteExternalClient(formData: FormData) {
  const { supabase } = await requireAccessManager();
  const email = value(formData, "email").toLowerCase();
  const fullName = value(formData, "full_name");
  const counterpartyId = value(formData, "counterparty_id");
  if (!email.includes("@") || fullName.length < 2 || !counterpartyId) done("error", "Заполните ФИО, почту и клиента");
  const view = checked(formData, "view");
  const download = checked(formData, "download");
  if (download && !view) done("error", "Для скачивания включите просмотр");
  const admin = createAdminClient();
  if (!admin) done("error", "Добавьте SUPABASE_SECRET_KEY в серверные переменные");
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? "http://localhost:3000";
  const { data, error } = await admin!.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo: `${origin}/auth/callback?next=/update-password` });
  if (error || !data.user) done("error", error?.message ?? "Supabase не создал приглашение");
  const { error: configureError } = await supabase.rpc("configure_external_client", {
    p_user_id: data.user!.id, p_counterparty_id: counterpartyId, p_full_name: fullName,
    p_phone: value(formData, "phone"), p_locale: value(formData, "locale") || "ru",
    p_view: view, p_download: download, p_upload: checked(formData, "upload"),
  });
  if (configureError) done("error", `Приглашение отправлено, но доступ требует проверки: ${configureError.message}`);
  revalidatePath("/admin/client-access");
  done("success", "Приглашение клиенту отправлено");
}

export async function setExternalAccess(formData: FormData) {
  const { supabase } = await requireAccessManager();
  const userId = value(formData, "user_id");
  const view = checked(formData, "view");
  const download = checked(formData, "download");
  if (download && !view) done("error", "Для скачивания включите просмотр");
  const { error } = await supabase.rpc("set_external_client_access", { p_user_id: userId, p_view: view, p_download: download, p_upload: checked(formData, "upload") });
  if (error) done("error", error.message);
  revalidatePath("/admin/client-access");
  done("success", "Права клиента обновлены");
}

export async function setExternalActive(formData: FormData) {
  const { supabase, user } = await requireAccessManager();
  const userId = value(formData, "user_id");
  const active = value(formData, "make_active") === "true";
  const { error } = await supabase.from("profiles").update({ is_active: active, deactivated_at: active ? null : new Date().toISOString(), deactivated_by: active ? null : user.id }).eq("id", userId).eq("user_type", "external");
  if (error) done("error", error.message);
  revalidatePath("/admin/client-access");
  done("success", active ? "Доступ восстановлен" : "Учётная запись отключена");
}
