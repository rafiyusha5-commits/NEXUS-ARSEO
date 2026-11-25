import "server-only";
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";

// The document check of a shipment, read once per server render: the overview and the check panel of the «Документы»
// tab show the same answer (they get the same client from the memoized requireUser). Outside a render it is a plain call.
export const loadShipmentDocumentCheck = cache((supabase: SupabaseClient, shipmentId: string) =>
  Promise.resolve(supabase.rpc("shipment_document_check", { p_shipment_id: shipmentId })));
