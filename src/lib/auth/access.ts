import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { grantsAll, type AccessPermission } from "@/lib/auth/access-permissions";
import { profileGate } from "@/lib/auth/signout";
import { unreadNotificationsCount } from "@/lib/notifications/unread";
import { loadPermissions } from "@/lib/permissions";

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

// The signed-in user, confirmed by the Auth server. Memoized for one server render (React cache): a page and the
// components inside it ask once. Outside a render (server actions, route handlers) cache() memoizes nothing.
const verifiedUser = cache(async () => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");
  return { supabase, user };
});

type VerifiedUser = Awaited<ReturnType<typeof verifiedUser>>;

// Profile and roles of the confirmed user; memoized per render by the (memoized) verified user object.
const accessContextOf = cache(async ({ supabase, user }: VerifiedUser) => {
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
});

async function loadAccessContext() {
  return accessContextOf(await verifiedUser());
}

type AccessContext = Awaited<ReturnType<typeof accessContextOf>>;

export async function requireUser() {
  const context = await loadAccessContext();
  if (context.profile.user_type === "external") redirect("/portal/documents");
  return context;
}

/**
 * requireUser for a page. After the user is confirmed, the profile and roles, the page's permission codes and the
 * sidebar's unread counter are requested together, in one round trip to the database, instead of one after another.
 * Permissions only hide or show controls; every rule is enforced again by RLS and triggers (src/lib/permissions.ts).
 */
export async function requirePageUser(): Promise<AccessContext>;
export async function requirePageUser<const T extends string>(
  permissions: readonly T[],
): Promise<AccessContext & { permissions: Record<T, boolean> }>;
export async function requirePageUser(codes: readonly string[] = []) {
  const verified = await verifiedUser();
  void unreadNotificationsCount();
  const [context, permissions] = await Promise.all([
    accessContextOf(verified),
    codes.length ? loadPermissions(verified.supabase, codes) : null,
  ]);
  if (context.profile.user_type === "external") redirect("/portal/documents");
  return permissions ? { ...context, permissions } : context;
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
