import Link from "next/link";
import { runLogistAction } from "@/app/logist/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { loadPermissions } from "@/lib/permissions";
import { parseProposals } from "@/lib/logist/proposals";
import { requireUser } from "@/lib/auth/access";
import { LogistProposalList } from "./logist-proposal-list";

// What Logist proposes for this shipment, on its main tab.
export async function LogistShipmentPanel({ shipmentId }: { shipmentId: string }) {
  // The render's own client (requireUser is memoized per render): permissions the page already asked for are
  // answered without another round trip (src/lib/permissions.ts).
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["shipments.view", "documents.view"] as const);
  if (!permissions["shipments.view"] || !permissions["documents.view"]) return null;
  const { data, error } = await supabase.from("logist_proposals")
    .select("id,shipment_id,kind,title,reason,status,created_at,decided_at,decision_note")
    .eq("shipment_id", shipmentId).eq("status", "pending").order("created_at");
  if (error) return null;
  const proposals = parseProposals(data);
  const back = `/shipments/${shipmentId}?tab=main`;
  return <section className="panel admin-section logist-panel" id="logist">
    <div className="panel-heading"><div><p className="eyebrow">Агент «Логист»</p><h2>Логист предлагает</h2></div><div className="topbar-actions">
      <form action={runLogistAction}><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="back" value={back}/><PendingSubmitButton className="ghost compact" pendingText="Проверяем…">Проверить</PendingSubmitButton></form>
      <Link className="ghost button-link compact" href="/logist">Все предложения</Link>
    </div></div>
    {proposals.length ? <LogistProposalList proposals={proposals} back={back}/> : <p className="form-help">Предложений нет. Логист проверяет поставку после смены этапа и работы с документами, а также по кнопке «Проверить».</p>}
  </section>;
}
