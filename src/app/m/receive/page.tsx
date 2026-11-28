import Link from "next/link";
import { requirePageUser } from "@/lib/auth/access";

type Row = { id: string; sequence_no: number; actual_arrival_date: string | null;
  shipment: { id: string; shipment_number: string; status: string; is_locked: boolean; warehouse: { code: string } | null } | null };

// Trucks to receive (202611280600): arrived and not yet received, in shipments open for receiving.
export default async function MobileReceiveList({ searchParams }: { searchParams: Promise<{ success?: string }> }) {
  const query = await searchParams;
  const { supabase, permissions } = await requirePageUser(["inventory.receive"] as const);
  const allowed = permissions["inventory.receive"];
  const { data } = allowed ? await supabase.from("shipment_transports")
    .select("id,sequence_no,actual_arrival_date,shipment:shipments(id,shipment_number,status,is_locked,warehouse:warehouses(code))")
    .eq("status", "arrived").order("actual_arrival_date", { ascending: true, nullsFirst: false }).limit(100) : { data: [] };
  const transports = ((data ?? []) as unknown as Row[]).filter(row => row.shipment && !row.shipment.is_locked && !["on_hold", "cancelled", "closed"].includes(row.shipment.status));
  const { data: receipts } = transports.length
    ? await supabase.from("shipment_transport_receipts").select("shipment_transport_id").in("shipment_transport_id", transports.map(row => row.id))
    : { data: [] };
  const received = new Set((receipts ?? []).map(row => row.shipment_transport_id));
  const open = transports.filter(row => !received.has(row.id));
  return <>
    <h1 className="mobile-title">Приёмка</h1>
    {query.success && <div className="login-success admin-message">{query.success}</div>}
    {!allowed && <section className="mobile-card mobile-card-warning"><strong>Нет права на приёмку</strong><small>Нужно право «Остатки: приёмка».</small></section>}
    {allowed && !open.length && <p className="mobile-hint">Прибывших машин к приёмке нет. Статус «Прибыл» ставят в карточке поставки.</p>}
    <nav className="mobile-menu" aria-label="Машины к приёмке">{open.map(row => <Link className="mobile-tile" key={row.id} href={`/m/receive/${row.id}`}>
      <strong>{row.shipment?.shipment_number} · машина №{row.sequence_no}</strong>
      <small>склад {row.shipment?.warehouse?.code ?? "—"}{row.actual_arrival_date ? ` · прибыла ${new Intl.DateTimeFormat("ru-RU").format(new Date(row.actual_arrival_date))}` : ""}</small>
    </Link>)}</nav>
    <p><Link href="/m">← Склад</Link></p>
  </>;
}
