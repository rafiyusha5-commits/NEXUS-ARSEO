import { loadDocumentActions } from "@/lib/documents/load-actions";
import { requireUser } from "@/lib/auth/access";
import type { QuantityProvenance } from "@/lib/shipments/quantity-provenance";
import { QuantityProvenanceView } from "./quantity-provenance";

export async function QuantityProvenancePanel({ shipmentId }: { shipmentId: string }) {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("shipment_quantity_provenance", { p_shipment_id: shipmentId });
  if (error || !data) return <section className="panel admin-section" aria-label="Откуда взялось количество"><h2>Откуда взялось количество</h2><p role="status">Полные данные не загружены. Обновите страницу. Количества не изменены.</p></section>;
  const provenance = data as QuantityProvenance;
  const documentActions = await loadDocumentActions(supabase, provenance.items.flatMap(item => item.history.map(event => event.documentId)));
  return <QuantityProvenanceView data={provenance} documentActions={documentActions}/>;
}
