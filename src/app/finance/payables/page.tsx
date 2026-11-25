import Link from "next/link";
import { redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { money, payableTotals, payeeHref, type PayableRow } from "@/lib/finance/payables";

const day = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "—";

// Whom we owe: actual expenses from "confirmed" on, by payee and currency (never added across currencies).
export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string; open?: string }> }) {
  const notice = await searchParams;
  // "Open a payee" (for an advance before any expense): only an id goes into the path.
  if (notice.open && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(notice.open)) redirect(`/finance/payables/${notice.open}`);
  const { profile, roles, supabase } = await requirePageUser();
  const [{ data, error }, { data: payees }] = await Promise.all([
    supabase.rpc("payables_summary"),
    supabase.from("counterparties").select("id,short_name,legal_name").eq("status", "active").overlaps("roles", ["supplier", "manufacturer", "carrier", "broker", "printing_house", "other"]).order("legal_name").limit(1000),
  ]);
  const rows = (data ?? []) as PayableRow[];
  const totals = payableTotals(rows);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="payables"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Финансы</p><h1>Кредиторская задолженность</h1></div></header>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}{notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {error && <div className="setup-notice">Кредиторка недоступна: нужно право «Финансы: просмотр» или миграция <strong>202611170400_payables.sql</strong>.</div>}
    {!error && <>
      <section className="shipment-summary-grid">
        {totals.map(total => <article className="summary-card" key={total.currency}><p>Остаток к оплате, {total.currency}</p><strong>{money(total.rest)}</strong><small>просрочено {money(total.overdue)}</small></article>)}
        {!totals.length && <article className="summary-card"><p>Остаток к оплате</p><strong>0</strong><small>долгов нет</small></article>}
      </section>
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">По получателям</p><h2>Начислено, оплачено, остаток</h2></div><span className="page-count">{rows.length}</span></div>
        <p className="form-help">В реестре фактические расходы с момента подтверждения, без отменённых и сторнированных. Оплаты вносятся частями в карточке получателя. Расход без срока оплаты отмечен «срок не задан» и просроченным не считается. Стоимость товара видна только с правом на закупочные цены. Плановые расходы сюда не входят. Аванс получателю показан отдельно и зачитывается в его расходы в карточке получателя.</p>
        <div className="import-table-wrap"><table className="import-table">
          <thead><tr><th>Получатель</th><th>Валюта</th><th>Начислено</th><th>Оплачено</th><th>Остаток</th><th>Аванс без зачёта</th><th>Переплата</th><th>Ближайший срок</th><th>Просрочка</th></tr></thead>
          <tbody>{rows.map(row => <tr key={`${row.payee_id}-${row.currency}`} className={row.overdue_days ? "has-error" : ""}>
            <td><Link href={payeeHref(row.payee_id)}>{row.payee ?? "Получатель не указан"}</Link><br/><small>открытых расходов: {row.open_expenses}{row.no_due_date ? ` · срок не задан: ${row.no_due_date}` : ""}</small></td>
            <td>{row.currency}</td><td>{money(row.accrued)}</td><td>{money(row.paid)}</td><td><strong>{money(row.rest)}</strong></td><td>{Number(row.advances ?? 0) ? money(row.advances) : "—"}</td><td>{Number(row.overpaid ?? 0) ? money(row.overpaid) : "—"}</td>
            <td>{day(row.nearest_due)}</td>
            <td>{row.overdue_days ? <>{row.overdue_days} дн.<br/><small>{money(row.overdue_amount, row.currency)}</small></> : "—"}</td>
          </tr>)}</tbody>
        </table></div>
        {!rows.length && <p className="empty-state">Подтверждённых фактических расходов нет.</p>}
        <form className="inline-action" action="/finance/payables"><label>Открыть получателя (например, чтобы внести аванс)<select name="open" required defaultValue="">
          <option value="" disabled>Выберите получателя</option>{(payees ?? []).map(payee => <option key={payee.id} value={payee.id}>{payee.short_name || payee.legal_name}</option>)}</select></label>
          <button className="ghost" type="submit">Открыть</button></form>
      </section>
    </>}
  </section></main>;
}
