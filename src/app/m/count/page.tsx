import Link from "next/link";
import { requirePageUser } from "@/lib/auth/access";
import { countKindLabel, countStatusLabel, type CountList } from "@/lib/inventory/counts";

// Counts open for counting (202611280300): the phone records the count; preparing, review and posting stay in the full version.
export default async function MobileCountList() {
  const { supabase } = await requirePageUser();
  const { data, error } = await supabase.rpc("inventory_count_list", { p_limit: 100 });
  const counts = ((data as CountList | null)?.counts ?? []).filter(count => count.status === "counting" || count.status === "recount");
  return <>
    <h1 className="mobile-title">Инвентаризация</h1>
    {error && <section className="mobile-card mobile-card-warning"><strong>Нет доступа к инвентаризации</strong><small>Нужно право на остатки или на инвентаризацию.</small></section>}
    {!error && !counts.length && <p className="mobile-hint">Сейчас ничего не пересчитывается. Пересчёт начинают в полной версии.</p>}
    <nav className="mobile-menu" aria-label="Идущие пересчёты">{counts.map(count => <Link className="mobile-tile" key={count.id} href={`/m/count/${count.id}`}>
      <strong>{count.number} · {count.warehouse}</strong><small>{countStatusLabel[count.status]} · {countKindLabel[count.kind]}{count.blind ? " · слепой" : ""} · записей {count.entries}</small>
    </Link>)}</nav>
    <p><Link href="/inventory/counts">Все инвентаризации — в полной версии</Link></p>
    <p><Link href="/m">← Склад</Link></p>
  </>;
}
