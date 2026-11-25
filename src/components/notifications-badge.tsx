import { unreadBadge } from "@/lib/notifications/rules.ts";
import { unreadNotificationsCount } from "@/lib/notifications/unread";

// Unread counter for the sidebar. The count is usually already on its way: requirePageUser starts it with the profile.
export async function NotificationsBadge() {
  const count = await unreadNotificationsCount();
  const label = unreadBadge(count);
  return label ? <span className="nav-badge" aria-label={`Непрочитанных уведомлений: ${count}`}>{label}</span> : null;
}
