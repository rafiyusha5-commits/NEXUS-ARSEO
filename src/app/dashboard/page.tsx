import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { ExecutiveTiles } from "@/components/executive-dashboard";
import { requirePageUser } from "@/lib/auth/access";
import { attention, DASHBOARD_TILES, dashboardMonth, monthLabel, shiftMonth, type DashboardTile } from "@/lib/dashboard/executive";

// The executive dashboard: every tile is a separate call of the tile function, all in one wave, so the slowest source
// sets the time of the page and a failed one does not take the others down. A tile without the rights to its data is
// absent (the function returns nothing).
export default async function ExecutiveDashboardPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const params = await searchParams;
  const { profile, roles, supabase, permissions } = await requirePageUser(["dashboard.executive.view"]);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const month = dashboardMonth(params.month, today);
  const current = month.slice(0, 7) === today.slice(0, 7);
  const results = permissions["dashboard.executive.view"]
    ? await Promise.allSettled(DASHBOARD_TILES.map(tile => supabase.rpc("executive_dashboard_tile", { p_tile: tile, p_month: month })))
    : [];
  const tiles = results.flatMap((result, index): DashboardTile[] => {
    if (result.status === "rejected" || result.value.error) return [{ tile: DASHBOARD_TILES[index], status: "error" }];
    return result.value.data ? [result.value.data as DashboardTile] : [];
  });
  const notes = attention(tiles);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="dashboard"/><section className="workspace executive-workspace">
    <header className="topbar"><div><p className="eyebrow">Руководителю · {monthLabel(month)}</p><h1>Дашборд</h1></div>
      <div className="topbar-actions"><Link className="ghost button-link" href="/?view=overview">Сводка дня</Link></div></header>
    {!permissions["dashboard.executive.view"] && <div className="setup-notice">Дашборд руководителя доступен администратору и директорам (право «Дашборд руководителя»).</div>}
    {permissions["dashboard.executive.view"] && <>
      <nav className="executive-months" aria-label="Месяц">
        <Link className="ghost button-link" href={`/dashboard?month=${shiftMonth(month, -1)}`}>← {monthLabel(`${shiftMonth(month, -1)}-01`)}</Link>
        {!current && <Link className="ghost button-link" href={`/dashboard?month=${shiftMonth(month, 1)}`}>{monthLabel(`${shiftMonth(month, 1)}-01`)} →</Link>}
        {!current && <Link className="text-button" href="/dashboard">Текущий месяц</Link>}
      </nav>
      {notes.length > 0 && <p className="executive-attention"><strong>Требует внимания:</strong> {notes.join(" · ")}</p>}
      <ExecutiveTiles tiles={tiles}/>
      {!tiles.length && <p className="empty-state">Нет плиток: для каждой нужны права на её данные (финансы, дебиторка, отчёты, поставки).</p>}
      <p className="form-help">Каждая цифра — из того же отчёта, что открывается по ссылке. Суммы в разных валютах сведены в тенге по официальному курсу на сегодня — это оценка; разбивка по валютам — в плитке и в отчёте. Месяц влияет на выручку и потери; долги, оплаты, прогноз денег, поставки и решения — на сегодня.</p>
    </>}
  </section></main>;
}
