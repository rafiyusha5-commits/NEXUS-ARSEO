import Link from "next/link";
import { requirePageUser } from "@/lib/auth/access";
import { shortDate } from "@/lib/scan/lookup";

type Row = { id: string; sale_number: string; planned_shipment_date: string; customer: { short_name: string | null; legal_name: string } | null;
  warehouse: { code: string } | null };

// Orders to pick (202611280600): confirmed orders, the nearest shipment first. Rows follow the rights to see sales.
export default async function MobilePickList() {
  const { supabase, permissions } = await requirePageUser(["inventory.move", "sales.view"] as const);
  const allowed = permissions["inventory.move"] && permissions["sales.view"];
  const { data } = allowed ? await supabase.from("sales")
    .select("id,sale_number,planned_shipment_date,customer:counterparties(short_name,legal_name),warehouse:warehouses(code)")
    .eq("status", "confirmed").order("planned_shipment_date").order("sale_number").limit(50) : { data: [] };
  const rows = (data ?? []) as unknown as Row[];
  return <>
    <h1 className="mobile-title">Отбор заказов</h1>
    {!allowed && <section className="mobile-card mobile-card-warning"><strong>Нет права отбирать заказы</strong><small>Нужны права «Остатки: движение» и «Продажи: просмотр».</small></section>}
    {allowed && !rows.length && <p className="mobile-hint">Подтверждённых заказов к отбору нет.</p>}
    <nav className="mobile-menu" aria-label="Заказы к отбору">{rows.map(row => <Link className="mobile-tile" key={row.id} href={`/m/pick/${row.id}`}>
      <strong>{row.sale_number}</strong><small>{row.customer?.short_name ?? row.customer?.legal_name ?? "—"} · {row.warehouse?.code ?? "—"} · отгрузка {shortDate(row.planned_shipment_date)}</small>
    </Link>)}</nav>
    <p><Link href="/m">← Склад</Link></p>
  </>;
}
