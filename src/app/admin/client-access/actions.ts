"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAccessManager } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { createAdminClient } from "@/lib/supabase/admin";
import { appOrigin } from "@/lib/auth/redirect";

const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const checked = (form: FormData, key: string) => form.get(key) === "on";
const done = (kind: "error" | "success", message: string): never => redirect(`/admin/client-access?${kind}=${encodeURIComponent(message)}`);

export async function inviteExternalClient(formData: FormData) {
  // Checked before the invitation is sent with the server key: it creates an account and grants document access.
  const { supabase } = await requireAccessManager(["users.manage", "roles.manage"]);
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
  const origin = appOrigin(process.env, requestHeaders);
  const { data, error } = await admin!.auth.admin.inviteUserByEmail(email, { data: { full_name: fullName }, redirectTo: `${origin}/auth/callback?next=/update-password` });
  if (error || !data.user) done("error", publicErrorMessage(error,"Не удалось отправить приглашение клиенту."));
  const { error: configureError } = await supabase.rpc("configure_external_client", {
    p_user_id: data.user!.id, p_counterparty_id: counterpartyId, p_full_name: fullName,
    p_phone: value(formData, "phone"), p_locale: value(formData, "locale") || "ru",
    p_view: view, p_download: download, p_upload: checked(formData, "upload"),
  });
  if (configureError) done("error", publicErrorMessage(configureError,"Приглашение отправлено, но доступ требует проверки администратором."));
  revalidatePath("/admin/client-access");
  done("success", "Приглашение клиенту отправлено");
}

export async function setExternalAccess(formData: FormData) {
  const { supabase } = await requireAccessManager(["roles.manage"]);
  const userId = value(formData, "user_id");
  const view = checked(formData, "view");
  const download = checked(formData, "download");
  if (download && !view) done("error", "Для скачивания включите просмотр");
  const { error } = await supabase.rpc("set_external_client_access", { p_user_id: userId, p_view: view, p_download: download, p_upload: checked(formData, "upload") });
  if (error) done("error", publicErrorMessage(error,"Не удалось обновить права клиента."));
  revalidatePath("/admin/client-access");
  done("success", "Права клиента обновлены");
}

export async function setExternalActive(formData: FormData) {
  const { supabase, user } = await requireAccessManager(["users.manage"]);
  const userId = value(formData, "user_id");
  const active = value(formData, "make_active") === "true";
  const { error } = await supabase.from("profiles").update({ is_active: active, deactivated_at: active ? null : new Date().toISOString(), deactivated_by: active ? null : user.id }).eq("id", userId).eq("user_type", "external");
  if (error) done("error", publicErrorMessage(error,"Не удалось изменить состояние учётной записи."));
  revalidatePath("/admin/client-access");
  done("success", active ? "Доступ восстановлен" : "Учётная запись отключена");
}
