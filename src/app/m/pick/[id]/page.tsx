import Link from "next/link";
import { notFound } from "next/navigation";
import { PickOrderView } from "@/components/mobile-pick";
import { requirePageUser } from "@/lib/auth/access";
import { type ScanResult } from "@/lib/scan/lookup";
import { matchPick, type PickList } from "@/lib/scan/operations";
import { confirmPick, shipPickedOrder } from "../actions";

type Search = { code?: string; batch?: string; via?: string; gs1_error?: string; error?: string; success?: string };

// Picking one order (202611280600): scan the batch on the shelf; the page says whether it is the reserved one, the
// database decides when the pick is written.
export default async function MobilePickOrder({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Search> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const { supabase } = await requirePageUser();
  const code = (query.code ?? "").trim().slice(0, 200);
  const batch = query.batch?.trim().slice(0, 40) || null;
  const [listResult, lookup] = await Promise.all([
    supabase.rpc("order_pick_list", { p_sale_id: id }),
    code && !query.gs1_error ? supabase.rpc("scan_lookup", { p_code: code, p_batch_number: batch }) : Promise.resolve(null),
  ]);
  if (listResult.error) return <>
    <h1 className="mobile-title">Отбор</h1>
    <section className="mobile-card mobile-card-warning"><strong>Заказ недоступен</strong><small>Нужны права «Остатки: движение» и «Продажи: просмотр», или заказа нет.</small></section>
    <p><Link href="/m/pick">← Заказы к отбору</Link></p>
  </>;
  const list = listResult.data as PickList;
  const match = code ? (query.gs1_error ? { kind: "not_found" as const } : matchPick(list, (lookup?.data ?? null) as ScanResult | null, batch)) : null;
  const message = query.error ? { type: "error" as const, text: query.error } : query.success ? { type: "success" as const, text: query.success } : null;
  return <PickOrderView list={list} match={match} code={code} batch={batch ?? undefined} message={message} pickAction={confirmPick} shipAction={shipPickedOrder}/>;
}
