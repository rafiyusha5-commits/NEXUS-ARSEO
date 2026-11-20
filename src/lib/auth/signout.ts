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

/**
 * The profile check of the protected pages (src/lib/auth/access.ts), kept next to `signoutDecision` so the two cannot
 * disagree: a page sends to `/auth/signout` only a missing or disabled profile, and for exactly those
 * `signoutDecision` ends the session, so the redirect cannot loop. A failed read is not a disabled profile: it is
 * thrown (the page shows an error) instead of being sent to the sign-out link, which would read the profile again,
 * find it active and send the employee back home.
 */
export function profileGate(profile: { is_active: boolean } | null, error: { message: string } | null): "active" | "signout" {
  if (error) throw new Error(`Не удалось прочитать профиль: ${error.message}`);
  return profile?.is_active ? "active" : "signout";
}
