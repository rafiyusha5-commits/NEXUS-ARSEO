import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { groupLabels, incompleteText, money, parseProfitParams, percent, type ProfitGroup, type ProfitReport } from "@/lib/analytics/profitability";

const day = (value: string) => new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`));

// Gross profit of what was shipped, in tenge: by shipment, product or customer. Requires reports.view and
// prices.purchase.view; the database refuses otherwise.
export default async function ProfitabilityPage({ searchParams }: { searchParams: Promise<{ group?: string; from?: string; to?: string }> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());
  const { group, from, to } = parseProfitParams(params, today);
  const { data, error } = await supabase.rpc("profitability_report", { p_group: group, p_from: from, p_to: to });
  const report = data as ProfitReport | null;
  const totals = report?.totals;
  const share = totals && Number(totals.revenue_net) !== 0 ? Number(totals.complete_revenue) / Number(totals.revenue_net) * 100 : null;
  const margin = totals && Number(totals.complete_revenue) !== 0 ? Number(totals.profit) / Number(totals.complete_revenue) * 100 : null;
  const query = (next: Partial<{ group: ProfitGroup; from: string; to: string }>) => {
    const values = { group, from, to, ...next };
    return `?group=${values.group}&from=${values.from}&to=${values.to}`;
  };
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="profitability"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Аналитика</p><h1>Прибыльность</h1></div>
      {!error && <div className="topbar-actions"><a className="ghost button-link" href={`/analytics/profitability/export?from=${from}&to=${to}`}>Скачать строки XLSX</a></div>}</header>
    {error && <div className="setup-notice">Отчёт о прибыльности доступен только с правами «Отчёты: просмотр» и «Закупочные цены и себестоимость».</div>}
    {!error && report && <>
      <form className="inline-action" action="/analytics/profitability">
        <input type="hidden" name="group" value={group}/>
        <label>С<input type="date" name="from" defaultValue={from}/></label><label>По<input type="date" name="to" defaultValue={to}/></label>
        <button className="ghost" type="submit">Показать</button>
      </form>
      <nav className="operation-tab-list" aria-label="Разрез отчёта">{(Object.keys(groupLabels) as ProfitGroup[]).map(key =>
        <Link key={key} className="operation-tab-button" aria-current={key === group ? "page" : undefined} href={query({ group: key })}>{groupLabels[key]}</Link>)}</nav>
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Выручка без НДС, KZT</p><strong>{money(totals?.revenue_net)}</strong><small>с НДС {money(totals?.revenue_gross)} · возвраты {money(totals?.returns_net)}</small></article>
        <article className="summary-card"><p>Валовая прибыль, KZT</p><strong>{money(totals?.profit)}</strong><small>маржа {percent(margin == null ? null : margin.toFixed(2))}</small></article>
        <article className="summary-card"><p>Выручка с полными данными</p><strong>{percent(share == null ? null : share.toFixed(2))}</strong><small>неполных строк: {totals?.incomplete_lines ?? 0} из {totals?.lines ?? 0}</small></article>
      </section>
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">{day(from)} — {day(to)}, в тенге</p><h2>{groupLabels[group]}</h2></div><span className="page-count">{report.rows.length}</span></div>
        <p className="form-help">Считается только отгруженное; возвраты уменьшают выручку и себестоимость периода возврата и показаны отдельно. Себестоимость строки — количество из конкретной партии × себестоимость этой партии. Выручка без НДС по ставке из настройки прайса. Пересчёт в тенге по официальному курсу на дату отгрузки (если курса на дату нет — последний за 7 дней); утверждённая себестоимость не пересчитывается заново, только переводится в тенге. Прибыль и маржа считаются только по строкам с полными данными; неполные строки видны с отметкой и в маржу как ноль не входят.</p>
        <div className="import-table-wrap"><table className="import-table">
          <thead><tr><th>{group === "shipment" ? "Поставка" : group === "product" ? "Товар" : "Клиент"}</th><th>Продажи без НДС</th><th>Возвраты</th><th>Выручка с полными данными</th><th>Себестоимость</th><th>Валовая прибыль</th><th>Маржа</th><th>Полнота</th>{group === "shipment" && <th>Не продано, шт.</th>}</tr></thead>
          <tbody>{report.rows.map(row => <tr key={row.key ?? "none"} className={incompleteText(row.statuses) ? "has-error" : ""}>
            <td>{row.name}{row.old_rule && <><br/><small className="load-warning-text">есть партии с себестоимостью по первой поставке</small></>}{incompleteText(row.statuses) && <><br/><small>{incompleteText(row.statuses)}</small></>}</td>
            <td>{money(row.sales_net)}</td><td>{Number(row.returns_net) ? money(row.returns_net) : "—"}</td><td>{money(row.complete_revenue)}</td>
            <td>{money(row.cost)}</td><td><strong>{money(row.profit)}</strong></td><td>{percent(row.margin_pct)}</td><td>{percent(row.complete_share_pct)}</td>
            {group === "shipment" && <td>{row.unsold_pieces == null ? "—" : Number(row.unsold_pieces).toLocaleString("ru-RU")}</td>}
          </tr>)}</tbody>
        </table></div>
        {!report.rows.length && <p className="empty-state">За период отгрузок и возвратов нет.</p>}
      </section>
    </>}
  </section></main>;
}
