import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Brings the Logist proposals of a shipment up to date after an employee changed it. A failure here must
// never undo or hide the employee's own action, so it is only logged.
export async function refreshLogistAfterChange(supabase: SupabaseClient, shipmentId: string) {
  try {
    const { error } = await supabase.rpc("run_logist", { p_shipment_id: shipmentId });
    if (error) console.error("[logist]", error.code ?? "rpc_error");
  } catch {
    console.error("[logist]", "unavailable");
  }
}
