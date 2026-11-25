import type { SupabaseClient } from "@supabase/supabase-js";
import { selectAll } from "../supabase/select-all";
import { documentActionIndex, type ActionDocument, type ActionSource, type DocumentActionIndex } from "./action-index";

export async function loadDocumentActions(session: SupabaseClient, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  const index: DocumentActionIndex = {};
  // Bound the PostgREST URL length with batches of 50; the batches are read in parallel, not one after another
  // (200 documents were four round trips in a row). Both reads use the caller's session and RLS.
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += 50) batches.push(unique.slice(start, start + 50));
  const results = await Promise.all(batches.map(batch => Promise.all([
    session.from("documents").select("id,current_version,archived_at,status,versions:document_versions!document_versions_document_id_fkey(id,is_current,version_number),links:document_links(entity_type,entity_id,removed_at)").in("id", batch).returns<ActionDocument[]>(),
    selectAll((from, to) => session.from("shipment_source_extractions")
      .select("id,document_id,document_version_id,shipment_id,shipment_transport_id,source_kind,status,extracted_data,confirmed_data,shipment:shipments!inner(shipment_number,vehicles:shipment_transports(id,status))")
      .in("document_id", batch).in("status", ["confirmed", "needs_review", "extracted"]).order("id").range(from, to).returns<ActionSource[]>()),
  ])));
  for (const [documents, sources] of results) Object.assign(index, documentActionIndex(documents.data ?? [], sources.data ?? []));
  return index;
}
