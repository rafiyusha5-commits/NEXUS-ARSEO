"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAccessManager } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";

function rolesRedirect(kind: "success" | "error", message: string): never {
  redirect(`/admin/roles?${kind}=${encodeURIComponent(message)}`);
}

export async function setRoleEnabled(formData: FormData) {
  const { supabase } = await requireAccessManager();
  const roleId = String(formData.get("role_id") ?? "");
  const roleCode = String(formData.get("role_code") ?? "");
  const enabled = String(formData.get("enabled")) === "true";
  if (!roleId) rolesRedirect("error", "Роль не найдена.");
  if (roleCode === "administrator" && !enabled) {
    rolesRedirect("error", "Системную роль администратора нельзя отключить.");
  }

  const { error } = await supabase.from("app_roles").update({ is_enabled: enabled }).eq("id", roleId);
  if (error) rolesRedirect("error", publicErrorMessage(error,"Не удалось изменить состояние роли."));
  revalidatePath("/admin/roles");
  rolesRedirect("success", enabled ? "Роль включена." : "Роль отключена.");
}

export async function setRolePermission(formData: FormData) {
  const { supabase } = await requireAccessManager();
  const roleId = String(formData.get("role_id") ?? "");
  const permissionId = String(formData.get("permission_id") ?? "");
  const grant = String(formData.get("grant")) === "true";
  if (!roleId || !permissionId) rolesRedirect("error", "Право или роль не найдены.");

  const { error } = grant
    ? await supabase.from("role_permissions").upsert(
        { role_id: roleId, permission_id: permissionId, granted: true },
        { onConflict: "role_id,permission_id" },
      )
    : await supabase.from("role_permissions").delete().eq("role_id", roleId).eq("permission_id", permissionId);

  if (error) rolesRedirect("error", publicErrorMessage(error,"Не удалось изменить права роли."));
  revalidatePath("/admin/roles");
  rolesRedirect("success", grant ? "Право выдано роли." : "Право отозвано у роли.");
}
