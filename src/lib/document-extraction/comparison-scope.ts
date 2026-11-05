/** An explicit review context wins over the original upload link, including a shared context. */
export function comparisonTransport(
  stored: { shipment_transport_id: string | null } | undefined,
  linkedTransportIds: string[],
  activeTransportIds: string[],
) {
  if (stored) return stored.shipment_transport_id;
  const ids = [...new Set(linkedTransportIds.filter(id => activeTransportIds.includes(id)))];
  return ids.length === 1 ? ids[0] : null;
}

/** Call after the existing access/current-version checks. Never mix another truck's quantities. */
export function comparisonItems<T extends { shipment_transport_id: string | null }>(items: T[], transportId: string | null, activeTransportIds: string[]) {
  return items.filter(item => transportId
    ? activeTransportIds.includes(transportId) && item.shipment_transport_id === transportId
    : !item.shipment_transport_id || activeTransportIds.includes(item.shipment_transport_id));
}

/** A shared source still needs the exact invoice/packing reference checked by CustomsEvidence. */
export function comparisonSources<T extends { shipment_transport_id: string | null }>(sources: T[], transportId: string | null) {
  return sources.filter(source => !transportId || !source.shipment_transport_id || source.shipment_transport_id === transportId);
}
