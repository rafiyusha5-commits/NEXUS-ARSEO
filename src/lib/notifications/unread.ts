import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// One HEAD count request, answered from the partial index notifications_unread_idx (RLS limits it to the signed-in
// user). Any failure hides the counter. Memoized for one request: requirePageUser starts it together with the
// profile, so the sidebar badge does not wait for the page's own queries before asking.
export const unreadNotificationsCount = cache(async (): Promise<number> => {
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
});
