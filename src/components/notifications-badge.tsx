import { unreadBadge } from "@/lib/notifications/rules.ts";
import { createClient } from "@/lib/supabase/server";

// One HEAD count request, answered from the partial index notifications_unread_idx
// (RLS limits it to the signed-in user). Any failure hides the counter.
async function unreadCount(): Promise<number> {
  try {
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("is_read", false);
    return error ? 0 : count ?? 0;
  } catch {
    return 0;
  }
}

// Unread counter for the sidebar.
export async function NotificationsBadge() {
  const count = await unreadCount();
  const label = unreadBadge(count);
  return label ? <span className="nav-badge" aria-label={`Непрочитанных уведомлений: ${count}`}>{label}</span> : null;
}
