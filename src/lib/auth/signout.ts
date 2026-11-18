/**
 * `/auth/signout` is reached by a plain link (GET): server components redirect a disabled employee there,
 * because they cannot clear the session cookies themselves. A GET can also be triggered by another site
 * (a link or an image), so it ends the session only for a profile that is really disabled. An active
 * employee keeps the session and is sent home; the regular "Выйти" button uses the `logout` server action (POST).
 */
export type SignoutDecision = { signOut: boolean; location: "/" | "/login" | "/login?error=disabled" };

export function signoutDecision(hasUser: boolean, profile: { is_active: boolean } | null): SignoutDecision {
  if (!hasUser) return { signOut: false, location: "/login" };
  if (profile?.is_active) return { signOut: false, location: "/" };
  return { signOut: true, location: "/login?error=disabled" };
}
