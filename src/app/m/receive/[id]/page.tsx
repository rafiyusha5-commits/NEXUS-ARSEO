import Link from "next/link";
import { notFound } from "next/navigation";
import { MobileReceiveForm, type ReceiveItem, type ReceiveLocation } from "@/components/mobile-receive-form";
import { requirePageUser } from "@/lib/auth/access";
import { receivingRows, type ShipmentExpected } from "@/lib/shipments/expected-batches";
import { receiveTransportMobile } from "../actions";

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "авто" };
type ItemRow = { id: string; product_id: string; uom: string; ordered_quantity: string; confirmed_quantity: string | null; shipped_quantity: string | null;
  product: { internal_sku: string; name: Record<string, string> | null } | null };

// Receiving one truck from a phone (202611280600): the lines of the full version, a GS1 scan fills batch and expiry.
export default async function MobileReceiveTruck({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { profile, supabase, permissions } = await requirePageUser(["inventory.receive"] as const);
  const { data: transport } = await supabase.from("shipment_transports")
    .select("id,shipment_id,sequence_no,status,shipment:shipments(id,shipment_number,status,is_locked,destination_warehouse_id)").eq("id", id).maybeSingle();
  if (!transport) notFound();
  const shipment = (Array.isArray(transport.shipment) ? transport.shipment[0] : transport.shipment) as
    { id: string; shipment_number: string; status: string; is_locked: boolean; destination_warehouse_id: string } | null;
  if (!shipment) notFound();
  const [{ data: itemRows }, { data: places }, { data: receipt }, { data: expectedData }] = await Promise.all([
    supabase.from("shipment_items").select("id,product_id,uom,ordered_quantity,confirmed_quantity,shipped_quantity,product:products(internal_sku,name)")
      .eq("shipment_id", shipment.id).eq("shipment_transport_id", id).order("created_at"),
    supabase.from("warehouse_locations").select("id,code,zone").eq("warehouse_id", shipment.destination_warehouse_id).eq("status", "active").order("code").limit(1000),
    supabase.from("shipment_transport_receipts").select("id,received_at,performed_by_name").eq("shipment_transport_id", id).maybeSingle(),
    supabase.rpc("shipment_expected_batches", { p_shipment_id: shipment.id }),
  ]);
  const expected = new Map(((expectedData as ShipmentExpected | null)?.items ?? []).map(item => [item.item_id, item.batches]));
  const rows = (itemRows ?? []) as unknown as ItemRow[];
  const { data: identifiers } = rows.length
    ? await supabase.from("product_identifiers").select("product_id,value").in("product_id", [...new Set(rows.map(row => row.product_id))])
    : { data: [] };
  const items: ReceiveItem[] = rows.map(row => ({
    item_id: row.id, title: `${row.product?.internal_sku ?? "—"} · ${row.product?.name?.ru ?? "—"}`,
    expected: Number(row.shipped_quantity ?? row.confirmed_quantity ?? row.ordered_quantity), unit: units[row.uom] ?? row.uom,
    codes: (identifiers ?? []).filter(identifier => identifier.product_id === row.product_id).map(identifier => identifier.value),
    batches: receivingRows(Number(row.shipped_quantity ?? row.confirmed_quantity ?? row.ordered_quantity), expected.get(row.id) ?? []),
  }));
  const canReceive = permissions["inventory.receive"] && transport.status === "arrived" && !receipt && !shipment.is_locked && !["on_hold", "cancelled", "closed"].includes(shipment.status);
  return <>
    <h1 className="mobile-title">{shipment.shipment_number} · машина №{transport.sequence_no}</h1>
    {query.error && <div className="login-error admin-message">{query.error}</div>}
    {receipt && <section className="mobile-card mobile-card-ok"><strong>Машина уже принята</strong>
      <small>{new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Almaty" }).format(new Date(receipt.received_at))} · {receipt.performed_by_name}</small></section>}
    {!receipt && !canReceive && <section className="mobile-card mobile-card-warning"><strong>Приёмка недоступна</strong>
      <small>{!permissions["inventory.receive"] ? "Нет права на приёмку." : transport.status !== "arrived" ? "Сначала в карточке поставки отметьте машину как прибывшую." : "Поставка закрыта, приостановлена или отменена."}</small></section>}
    {canReceive && !items.length && <p className="mobile-hint">В этой машине нет распределённых товаров.</p>}
    {canReceive && items.length > 0 && <MobileReceiveForm shipmentId={shipment.id} transportId={id} items={items} locations={(places ?? []) as ReceiveLocation[]}
      performer={profile.full_name} action={receiveTransportMobile}/>}
    <p><Link href="/m/receive">← Машины к приёмке</Link></p>
  </>;
}
