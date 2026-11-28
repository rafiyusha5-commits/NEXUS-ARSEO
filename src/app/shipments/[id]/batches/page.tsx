import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { ExpectedBatchesView } from "@/components/shipments/expected-batches-view";
import { requirePageUser } from "@/lib/auth/access";
import { packingLots, type ShipmentExpected, type SourceRow } from "@/lib/shipments/expected-batches";
import { addExpectedBatch, cancelExpectedBatch } from "../../batch-actions";

type Search = { error?: string; success?: string };

// Batches of the packing list and their labels, before the truck arrives (202611280700). The labels are printed now and
// stuck on at the receipt; the receipt binds each to the batch received if the number of the same item (and the expiry
// of the list, when given) match — the database decides, nothing is guessed.
export default async function ShipmentBatchesPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { profile, roles, supabase } = await requirePageUser();
  const [{ data, error }, { data: sources }] = await Promise.all([
    supabase.rpc("shipment_expected_batches", { p_shipment_id: id }),
    supabase.from("shipment_source_extractions").select("status,extracted_data,document:documents(title)").eq("shipment_id", id).limit(200),
  ]);
  if (error || !data) notFound();
  const shipment = data as ShipmentExpected;
  const open = shipment.items.filter(item => !item.received);
  const added = shipment.items.flatMap(item => item.batches.filter(batch => batch.state !== "cancelled").map(batch => batch.batch));
  const lots = shipment.can_manage && open.length ? packingLots((sources ?? []) as unknown as SourceRow[], added) : [];
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Партии по упаковочному листу</p><h1>{shipment.shipment_number}</h1></div>
      <div className="topbar-actions"><Link className="ghost button-link" href={`/shipments/${shipment.shipment_id}`}>К карточке поставки</Link></div></header>
    <ExpectedBatchesView shipment={shipment} lots={lots} message={query.error ? { type: "error", text: query.error } : query.success ? { type: "success", text: query.success } : null}
      addAction={addExpectedBatch} cancelAction={cancelExpectedBatch}/>
  </section></main>;
}
