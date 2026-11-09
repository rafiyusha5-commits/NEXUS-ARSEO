import { currentCommoditySource } from "../document-extraction/commodity-evidence.ts";
import { hasReviewTables, reviewDefinitions } from "../document-extraction/review-definitions.ts";

export type ActionDocument = {
  id: string; current_version: number; archived_at: string | null; status: string;
  versions: { id: string; version_number: number; is_current: boolean }[];
  links: { entity_id: string; entity_type: string; removed_at: string | null }[];
};
export type ActionSource = {
  id: string; document_id: string; document_version_id: string; shipment_id: string;
  shipment_transport_id: string | null; status: string; source_kind: string;
  confirmed_data: Record<string, unknown>; extracted_data: Record<string, unknown>;
  shipment: { shipment_number: string; vehicles: { id: string; status: string }[] } | null;
};
export type DocumentActionInfo = {
  id: string; current: number; files: Record<number, string>;
  reviews: { href: string; shipment: string }[];
};
export type DocumentActionIndex = Record<string, DocumentActionInfo>;

export function documentActionIndex(documents: ActionDocument[], sources: ActionSource[]): DocumentActionIndex {
  const byId = new Map(documents.map(document => [document.id, document]));
  const index: DocumentActionIndex = {};
  for (const doc of documents) {
    const files: Record<number, string> = {};
    for (const file of doc.versions) {
      if (file.is_current === (file.version_number === doc.current_version)) files[file.version_number] = file.id;
    }
    index[doc.id] = { id: doc.id, current: doc.current_version, files, reviews: [] };
  }
  for (const source of sources) {
    const doc = byId.get(source.document_id);
    if (!doc || !source.shipment) continue;
    const active = source.shipment.vehicles.filter(vehicle => vehicle.status !== "cancelled").map(vehicle => vehicle.id);
    if (!currentCommoditySource(source, doc, source.shipment_id, active)) continue;
    const values = source.status === "confirmed" ? source.confirmed_data : source.extracted_data;
    const hasFields = reviewDefinitions(source).some(({ key }) => {
      const value = values?.[key];
      return typeof value === "number" || (typeof value === "string" && value.trim().length > 0);
    });
    if (hasFields || hasReviewTables(source.extracted_data)) {
      index[doc.id].reviews.push({
        href: `/shipments/${source.shipment_id}?tab=documents#source-result-${source.id}`, shipment: source.shipment.shipment_number,
      });
    }
  }
  return index;
}
