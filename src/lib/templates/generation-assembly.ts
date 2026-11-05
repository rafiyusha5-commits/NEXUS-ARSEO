// Builds the data of ONE document set (one vehicle) from rows already read from the database. Pure, so the
// rule "nothing of another vehicle enters this set" can be tested without a database:
//   * cargo: only the items bound to the chosen vehicle (see selectGenerationScope);
//   * vehicle: only the chosen vehicle's row;
//   * confirmed documents: shipment-level facts from every document, vehicle facts only from documents bound to
//     this vehicle (mergeConfirmedSources);
//   * invoice lines are used for prices and HS codes of this vehicle's items, never to add goods.

import { mergeConfirmedSources, scopeConfirmedSources } from "../document-extraction/rules.ts";
import { buildShipmentGenerationData } from "./generation.ts";
import { selectGenerationScope } from "./generation-scope.ts";

type Row = Record<string, unknown>;

const one = <T,>(value: T | T[] | null | undefined): T | undefined => Array.isArray(value) ? value[0] : value ?? undefined;

export type SourceRow = { confirmed_data?: unknown; extracted_data?: unknown; shipment_transport_id?: string | null };

export type AssemblyInput = {
  shipment: Row;
  items: Row[];
  /** Active (not cancelled) vehicles of the shipment. */
  transports: Row[];
  transportId?: string;
  products: Row[];
  identifiers: Row[];
  packaging: Row[];
  priceByItem: Map<string, unknown>;
  includePrices: boolean;
  sources: SourceRow[];
  sourcesUnavailable?: boolean;
};

export function assembleGenerationData(input: AssemblyInput) {
  const { selectedTransport, selectedItems } = selectGenerationScope(input.items as Array<Row & { shipment_transport_id?: unknown }>, input.transports, input.transportId);
  const { shipment } = input;
  const normalizedItems = selectedItems.map(item => ({
    ...item,
    shipment_transport_id: item.shipment_transport_id ?? selectedTransport?.id ?? null,
    unit_price: input.includePrices ? input.priceByItem.get(String(item.id)) ?? null : null,
    currency_code: one(item.currency as unknown as Array<{ code: string }>)?.code,
  }));
  const normalizedTransports = input.transports.map((transport): Row => {
    const carrier = one(transport.carrier as unknown as Row[]);
    return {
      ...transport,
      carrier: carrier ? { ...carrier, counterparty: one(carrier.counterparty as Row[]) } : undefined,
      vehicle: one(transport.vehicle as unknown as Row[]),
    };
  });
  const generationTransports = selectedTransport ? normalizedTransports.filter(transport => transport.id === selectedTransport.id) : normalizedTransports;
  const baseData = buildShipmentGenerationData({
    shipment,
    supplier: one(shipment.supplier as Row[]), customer: one(shipment.customer as Row[]), route: one(shipment.route as Row[]),
    warehouse: one(shipment.warehouse as Row[]), responsible: one(shipment.responsible as Row[]), currency: one(shipment.currency as Row[]), contract: one(shipment.contract as Row[]),
    items: normalizedItems as Row[],
    products: new Map(input.products.map(product => [String(product.id), product])),
    identifiers: input.identifiers, packaging: input.packaging,
    transports: generationTransports as Row[], includePrices: input.includePrices,
  });
  const vehicleCount = input.transports.length;
  const bound = input.sources.map(row => ({ data: (row.confirmed_data ?? {}) as Row, transportId: row.shipment_transport_id ?? null }));
  const scope = { transportId: selectedTransport?.id as string | undefined ?? null, transportCount: vehicleCount };
  const confirmed = scopeConfirmedSources(bound, scope).own;
  const unallocated = vehicleCount > 1 ? input.items.filter(item => !item.shipment_transport_id).length : 0;
  const invoiceLines = input.sourcesUnavailable ? [] : input.sources.flatMap(row => {
    if (row.shipment_transport_id && row.shipment_transport_id !== scope.transportId) return [];
    const lines = (row.extracted_data as Row | null)?.invoice_items;
    return Array.isArray(lines) ? lines : [];
  });
  const merged = input.sourcesUnavailable ? baseData : mergeConfirmedSources(baseData, bound, scope);
  const data = {
    ...merged,
    invoice_lines: invoiceLines,
    prices_included: input.includePrices,
    selected_transport_id: selectedTransport?.id ?? null,
    selected_transport_sequence: selectedTransport?.sequence_no ?? null,
    unallocated_item_count: unallocated,
    // The invoice lists the goods of every vehicle, so it is compared with a single vehicle's cargo only for price and HS code.
    vehicle_scoped: vehicleCount > 1,
  } as typeof baseData & Row;
  const confirmedSourceFields = input.sourcesUnavailable ? [] : [...new Set(confirmed.flatMap(source => Object.keys(source)))];
  return { data, selectedTransport, selectedItems, confirmedSourceFields };
}
