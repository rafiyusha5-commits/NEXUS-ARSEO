import type { PreparationInput, PreparationSource } from "../../src/lib/shipments/historical-preparation.ts";
export function preparationFixture(kind: "complete" | "incomplete" | "conflicting"): PreparationInput {
  const source = (id: string, group: string, transport: string | null, data: Record<string, unknown>): PreparationSource => ({
    id, document_id: `doc-${id}`, document_version_id: `v-${id}`, updated_at: "2026-10-21T10:00:00Z", reviewed_at: "2026-10-21T10:00:00Z",
    shipment_transport_id: transport, status: "confirmed", source_kind: group === "procurement" ? "invoice" : "waybill",
    extracted_data: data, confirmed_data: data,
    document: { title: `Синтетический ${id}`, archived_at: null, status: "approved", current_version: 1,
      versions: [{ id: `v-${id}`, is_current: true, version_number: 1 }], links: [{ entity_type: "shipment", entity_id: "s", removed_at: null }] } as PreparationSource["document"],
  });
  const sources = kind === "incomplete" ? [] : [source("invoice", "procurement", null, { invoice_number: "SYN-10", invoice_items: [{ sku: "SYN-A", quantity: 965, uom: "шт" }] }),
    { ...source("packing", "procurement", null, { packing_list_number: "SYN-P10", invoice_items: [{ sku: "SYN-A", quantity: 965, uom: "шт" }] }), source_kind: "specification" },
    source("cmr-a", "import_transport", "a", { cmr_number: "SYN-CMR-A", vehicle_plate: "SYN-A" }), source("customs", "customs", null, { invoice_number: "SYN-10" }),
    source("sale", "sale", null, { invoice_number: "SYN-SALE-20" }), source("export", "export_transport", "a", { cmr_number: "SYN-EXPORT", vehicle_plate: "SYN-EXPORT" })];
  if (kind === "conflicting") sources.push(source("cmr-b", "import_transport", "b", { cmr_number: "SYN-CMR-B", vehicle_plate: "SYN-B" }), source("translation", "import_transport", "a", { cmr_number: "SYN-CONFLICT", vehicle_plate: "SYN-A" }));
  return { shipmentId: "s", complete: true, transportIds: ["a", "b"], sources,
    choices: sources.map(s => ({ id: s.id, version: s.document_version_id, updated: s.updated_at, group: ["invoice", "packing"].includes(s.id) ? "procurement" : s.id === "customs" ? "customs" : s.id === "sale" ? "sale" : s.id === "export" ? "export_transport" : "import_transport", variant: s.id === "translation" ? "translation" : "original" })),
    items: [{ id: "item-a", uom: "piece", shipment_transport_id: null, product: { internal_sku: "SYN-A", name: { ru: "Вымышленный товар" } } }],
  };
}
