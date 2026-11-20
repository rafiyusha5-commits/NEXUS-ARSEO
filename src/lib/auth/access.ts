import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { grantsAll, type AccessPermission } from "@/lib/auth/access-permissions";
import { profileGate } from "@/lib/auth/signout";

export type AccessRole = {
  id: string;
  code: string;
  name: string;
};

export type AccessProfile = {
  id: string;
  full_name: string;
  job_title: string | null;
  locale: string;
  is_active: boolean;
  user_type: "employee" | "external";
  counterparty_id: string | null;
  phone: string | null;
};

async function loadAccessContext() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: profile, error: profileError }, { data: assignments }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, job_title, locale, is_active, user_type, counterparty_id, phone")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("user_roles")
      .select("app_roles(id, code, name)")
      .eq("user_id", user.id),
  ]);

  // The sign-out link checks the profile again and ends only a disabled employee's session (src/lib/auth/signout.ts).
  if (profileGate(profile, profileError) === "signout") redirect("/auth/signout");

  const roles = (assignments ?? []).flatMap(
    (assignment) => assignment.app_roles ?? [],
  ) as AccessRole[];

  return {
    supabase,
    user,
    profile: profile as AccessProfile,
    roles,
  };
}

export async function requireUser() {
  const context = await loadAccessContext();
  if (context.profile.user_type === "external") redirect("/portal/documents");
  return context;
}

export async function requirePortalUser() {
  const context = await loadAccessContext();
  if (context.profile.user_type !== "external" || !context.profile.counterparty_id) redirect("/");
  return context;
}

/**
 * Administration screens are offered to administrators and directors. An action additionally names the permissions
 * it needs; they are checked in the database right away, so a personal deny stops the action before anything is sent
 * with the server key (src/lib/auth/access-permissions.ts).
 */
export async function requireAccessManager(permissions: readonly AccessPermission[] = []) {
  const context = await requireUser();
  const allowed = context.roles.some((role) =>
    ["administrator", "director"].includes(role.code),
  );

  if (!allowed) redirect("/?error=forbidden");
  if (permissions.length) {
    const { data, error } = await context.supabase.rpc("my_permissions", { p_codes: [...permissions] });
    if (!grantsAll(permissions, data, error)) redirect("/?error=forbidden");
  }
  return context;
}

export function roleLabel(roles: AccessRole[], fallback: string | null) {
  return roles.map((role) => role.name).join(", ") || fallback || "Сотрудник";
}
