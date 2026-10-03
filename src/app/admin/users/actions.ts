"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAccessManager } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { createAdminClient } from "@/lib/supabase/admin";

function usersRedirect(kind: "success" | "error", message: string): never {
  redirect(`/admin/users?${kind}=${encodeURIComponent(message)}`);
}

export async function inviteUser(formData: FormData) {
  const { supabase, user: actor } = await requireAccessManager();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const fullName = String(formData.get("full_name") ?? "").trim();
  const jobTitle = String(formData.get("job_title") ?? "").trim();
  const roleId = String(formData.get("role_id") ?? "");

  if (!email.includes("@") || !fullName || !roleId) {
    usersRedirect("error", "Заполните ФИО, корпоративную почту и роль.");
  }

  const admin = createAdminClient();
  if (!admin) {
    usersRedirect("error", "Для приглашений нужно добавить SUPABASE_SECRET_KEY в серверные переменные.");
  }

  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin") ?? "http://localhost:3000";
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName },
    redirectTo: `${origin}/auth/callback?next=/update-password`,
  });

  if (error || !data.user) {
    usersRedirect("error", publicErrorMessage(error,"Не удалось отправить приглашение."));
  }

  const { error: profileError } = await supabase
    .from("profiles")
    .update({ full_name: fullName, job_title: jobTitle || null })
    .eq("id", data.user.id);
  const { error: roleError } = await supabase.from("user_roles").insert({
    user_id: data.user.id,
    role_id: roleId,
    assigned_by: actor.id,
  });

  if (profileError || roleError) {
    usersRedirect("error", "Пользователь приглашён, но профиль или роль требуют проверки.");
  }

  revalidatePath("/admin/users");
  usersRedirect("success", "Приглашение отправлено сотруднику.");
}

export async function setUserActive(formData: FormData) {
  const { supabase, user } = await requireAccessManager();
  const userId = String(formData.get("user_id") ?? "");
  const makeActive = String(formData.get("make_active")) === "true";

  if (!userId || (userId === user.id && !makeActive)) {
    usersRedirect("error", "Нельзя отключить собственную учётную запись.");
  }

  const { error } = await supabase
    .from("profiles")
    .update({
      is_active: makeActive,
      deactivated_at: makeActive ? null : new Date().toISOString(),
      deactivated_by: makeActive ? null : user.id,
    })
    .eq("id", userId);

  if (error) usersRedirect("error", publicErrorMessage(error,"Не удалось изменить доступ сотрудника."));
  revalidatePath("/admin/users");
  usersRedirect("success", makeActive ? "Доступ сотрудника восстановлен." : "Доступ сотрудника отключён.");
}

export async function assignRole(formData: FormData) {
  const { supabase, user } = await requireAccessManager();
  const userId = String(formData.get("user_id") ?? "");
  const roleId = String(formData.get("role_id") ?? "");
  if (!userId || !roleId) usersRedirect("error", "Выберите роль.");

  const { error } = await supabase.from("user_roles").insert({
    user_id: userId,
    role_id: roleId,
    assigned_by: user.id,
  });
  if (error) usersRedirect("error", error.code === "23505" ? "Эта роль уже назначена." : publicErrorMessage(error,"Не удалось назначить роль."));
  revalidatePath("/admin/users");
  usersRedirect("success", "Роль назначена.");
}

export async function removeRole(formData: FormData) {
  const { supabase } = await requireAccessManager();
  const userId = String(formData.get("user_id") ?? "");
  const roleId = String(formData.get("role_id") ?? "");
  if (!userId || !roleId) usersRedirect("error", "Не удалось определить назначение роли.");

  const { error } = await supabase
    .from("user_roles")
    .delete()
    .eq("user_id", userId)
    .eq("role_id", roleId);
  if (error) usersRedirect("error", publicErrorMessage(error,"Не удалось снять роль."));
  revalidatePath("/admin/users");
  usersRedirect("success", "Роль снята.");
}
