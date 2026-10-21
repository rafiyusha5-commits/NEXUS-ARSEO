import { createRoot } from "react-dom/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadShipmentReport } from "../../src/lib/shipment-report";
import { loadShipmentOutcome } from "../../src/lib/shipment-outcome";
import { ShipmentOutcomeSections } from "../../src/components/reports/shipment-outcome-sections";
import { snapshotClient } from "./snapshot-client";

async function render() {
  const { report: snapshot, backend } = await (await fetch("/capture.json")).json();
  const restricted = new URL(location.href).searchParams.has("restricted");
  const { client, calls } = snapshotClient(snapshot, !restricted);
  const grants = new Set(restricted ? [] : ["prices.purchase.view", "costing.view", "inventory.view", "products.view", "sales.view", "documents.view"]);
  const db = client as unknown as SupabaseClient;
  const report = await loadShipmentReport(db, snapshot.shipments[0].id, grants);
  if (!report) throw new Error("Pilot report is missing");
  const outcome = await loadShipmentOutcome(db, report.shipment.id, report.items.map(i => i.id), grants);
  createRoot(document.getElementById("root")!).render(<>
    <h1>Синтетический исторический пилот</h1>
    <p>Источник: {backend}. Это проверка компонента отчёта по SQL-снимку, не полный браузерный цикл Nexus.</p>
    <p data-testid="totals">Заказано {report.totals.ordered}; принято {report.totals.accepted}; автомобили {report.transports.length}; документы {report.documents.length}</p>
    <ShipmentOutcomeSections outcome={outcome} items={report.items}/>
    <output data-testid="rpc-calls">{calls.join(",")}</output>
  </>);
}
render().catch(error => { document.getElementById("root")!.textContent = `TEST FAILED: ${error.message}`; });
