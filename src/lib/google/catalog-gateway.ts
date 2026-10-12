import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "../supabase/config.ts";

/** A second server credential, NOT a replacement for the employee JWT/RLS.
 * Never return this client or its headers to a caller. No service_role is used.
 */
export async function catalogGateway(sessionClient: SupabaseClient): Promise<SupabaseClient> {
  const secret = process.env.DRIVE_CATALOG_GATEWAY_SECRET;
  if (!secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("CATALOG_UNAVAILABLE");
  const { data, error } = await sessionClient.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("CATALOG_UNAVAILABLE");
  const { url, publishableKey } = getSupabaseEnv();
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${data.session.access_token}`, "x-nexus-drive-gateway": secret },
      fetch: (input, init) => {
        const target = new URL(String(input));
        if (target.origin !== new URL(url).origin || !/^\/rest\/v1\/(drive_catalog_files|drive_catalog_text|rpc\/search_drive_catalog)$/.test(target.pathname)) throw new Error("CATALOG_UNAVAILABLE");
        return fetch(input, { ...init, redirect: "error", cache: "no-store",
          signal: AbortSignal.any([AbortSignal.timeout(10000), ...(init?.signal ? [init.signal] : [])]) });
      },
    },
  });
}
