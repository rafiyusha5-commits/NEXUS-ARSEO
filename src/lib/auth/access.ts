import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
};

export async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const [{ data: profile }, { data: assignments }] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, full_name, job_title, locale, is_active")
      .eq("id", user.id)
      .single(),
    supabase
      .from("user_roles")
      .select("app_roles(id, code, name)")
      .eq("user_id", user.id),
  ]);

  if (!profile?.is_active) redirect("/auth/signout?reason=disabled");

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

export async function requireAccessManager() {
  const context = await requireUser();
  const allowed = context.roles.some((role) =>
    ["administrator", "director"].includes(role.code),
  );

  if (!allowed) redirect("/?error=forbidden");
  return context;
}

export function roleLabel(roles: AccessRole[], fallback: string | null) {
  return roles.map((role) => role.name).join(", ") || fallback || "Сотрудник";
}
