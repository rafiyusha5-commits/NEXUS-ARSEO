import Link from "next/link";
import { ScanField } from "@/components/scan-field";
import { requirePageUser } from "@/lib/auth/access";

// Home of the mobile warehouse: the scan field and the operations as large buttons.
export default async function MobileHome() {
  const { profile } = await requirePageUser();
  return <>
    <h1 className="mobile-title">Добрый день, {profile.full_name.split(/\s+/)[0]}</h1>
    <ScanField/>
    <nav className="mobile-menu" aria-label="Операции склада">
      <Link className="mobile-tile" href="/m/scan"><strong>Поиск по коду</strong><small>что, где, сколько свободно, срок</small></Link>
      <Link className="mobile-tile" href="/m/labels"><strong>Этикетки</strong><small>места и партии: A4 или термопринтер</small></Link>
      <Link className="mobile-tile" href="/inventory/counts"><strong>Инвентаризация</strong><small>пересчёт мест (слепой подсчёт)</small></Link>
    </nav>
  </>;
}
