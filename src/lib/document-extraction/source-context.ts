import { currentCommoditySource } from "./commodity-evidence.ts";
type CurrentDocument = NonNullable<Parameters<typeof currentCommoditySource>[1]>;
export type ContextSource = Parameters<typeof currentCommoditySource>[0] & {
  document: CurrentDocument | CurrentDocument[] | null;
};
export function usableSourceContext(source: ContextSource, shipmentId: string, transportIds: string[]) {
  const document = Array.isArray(source.document) ? source.document[0] : source.document;
  if (!currentCommoditySource(source, document, shipmentId, transportIds)) return false;
  return Boolean(document?.links.some(l => !l.removed_at && (
    l.entity_type === "shipment" && l.entity_id === shipmentId
    || l.entity_type === "shipment_transport" && l.entity_id === source.shipment_transport_id
  )));
}
