import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseEnv } from "../supabase/config.ts";

export async function shipmentDriveGateway(session: SupabaseClient) {
  const secret = process.env.DRIVE_CATALOG_GATEWAY_SECRET;
  const { data, error } = await session.auth.getSession();
  if (error || !data.session || !secret || !/^[a-f0-9]{64}$/.test(secret)) throw new Error("Подключение Drive не настроено");
  const { url, publishableKey } = getSupabaseEnv();
  return createClient(url, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      headers: { Authorization: `Bearer ${data.session.access_token}`, "x-nexus-drive-gateway": secret },
      fetch: (input, init) => {
        const target = new URL(String(input));
        if (target.origin !== new URL(url).origin || !/^\/rest\/v1\/(shipment_drive_folders|shipment_drive_files|shipment_drive_operations|rpc\/(bind_shipment_drive_folder|scan_shipment_drive_folder|import_shipment_drive_file|check_shipment_drive_content|link_shipment_drive_document|begin_shipment_drive_operation|record_shipment_drive_operation))$/.test(target.pathname)) throw new Error("Недопустимый запрос Drive");
        return fetch(input, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.any([AbortSignal.timeout(20000), ...(init?.signal ? [init.signal] : [])]) });
      },
    },
  });
}
