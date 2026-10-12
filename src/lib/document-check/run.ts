import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Runs the document check agent after recognition or confirmation, with the employee's own session.
// A failed check never breaks the recognition itself: the card shows the current findings anyway and
// the daily run catches up.
export async function runDocumentCheckAfterRecognition(supabase: SupabaseClient, shipmentId: string) {
  try {
    const { error } = await supabase.rpc("run_shipment_document_check", { p_shipment_id: shipmentId, p_source: "recognition" });
    if (error) console.error("[document-check]", error.code ?? "rpc_error");
  } catch {
    console.error("[document-check]", "unavailable");
  }
}
