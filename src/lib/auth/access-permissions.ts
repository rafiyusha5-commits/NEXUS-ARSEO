/**
 * Permissions behind the administration screens. The database decides them (`my_permissions` → `private.has_permission`),
 * so a personal deny of a director or administrator takes effect here as well, not only in RLS. This matters before
 * calls with the server key (invitations): they run before any query under the employee's own rights.
 */
export type AccessPermission = "users.manage" | "roles.manage";

/** True only when the database returned every required code; an error or an unreadable answer is a refusal. */
export function grantsAll(required: readonly AccessPermission[], data: unknown, error: unknown): boolean {
  if (error || !Array.isArray(data)) return required.length === 0;
  const granted = new Set(data.filter((code): code is string => typeof code === "string"));
  return required.every((code) => granted.has(code));
}
