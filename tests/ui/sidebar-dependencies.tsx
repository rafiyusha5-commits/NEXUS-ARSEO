// Browser fixture: no session, network calls or real sign-out action.
export function roleLabel() { return "Проверочная учётная запись"; }
export function NotificationsBadge() { return null; }
export async function logout() { throw new Error("SYNTHETIC_LOGOUT_NOT_ALLOWED"); }
