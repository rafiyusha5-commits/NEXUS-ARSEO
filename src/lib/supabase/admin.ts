import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "./config";

export function createAdminClient() {
  const serverKey =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serverKey) return null;

  const { url } = getSupabaseEnv();
  return createClient(url, serverKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
