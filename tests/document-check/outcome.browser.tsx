import { createRoot } from "react-dom/client";
import { CustomsEvidence } from "../../src/components/documents/customs-evidence";
import { buildShipmentDocumentReadiness } from "../../src/lib/templates/readiness";
import type { CommodityLine } from "../../src/lib/document-extraction/commodity-evidence";

const line: CommodityLine = { number: 1, sku: "SYNTH-A", description: "Synthetic candy", hsCode: "1806901900", quantity: 965, unit: "piece", amount: 100, grossKg: 10, netKg: 9, customsValue: 200, warnings: [] };
createRoot(document.getElementById("root")!).render(<CustomsEvidence
  current reviewed
  value={{ kind: "declaration", fields: [{ label: "Номер", value: "SYNTH-DT" }], expectedCount: 1, currency: "EUR", items: [line], invoiceNumbers: ["SYNTH-INV"], packingNumbers: ["WZ SYNTH-PL"], warnings: ["Результат чтения"], validationWarnings: [] }}
  invoices={[{ number: "SYNTH-INV", currency: "EUR", total: 100, items: [line], warnings: [] }]}
  shipment={[{ sku: "SYNTH-A", unit: "piece", ordered: 1000, confirmed: 965, shipped: 965, hsCode: line.hsCode }]}
  packing={[{ number: "SYNTH-PL", total: 965, items: [{ sku: "SYNTH-A", unit: "piece", quantity: 965 }], warnings: [] }]}
  readiness={buildShipmentDocumentReadiness({ shipment_type: "import", shipment_number: "SYNTH" })}
/>);
