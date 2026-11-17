import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { money, payableTotals, payeeHref, type PayableRow } from "@/lib/finance/payables";

const day = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "—";

// Whom we owe: actual expenses from "confirmed" on, by payee and currency (never added across currencies).
export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const notice = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const { data, error } = await supabase.rpc("payables_summary");
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
        <p className="form-help">В реестре фактические расходы с момента подтверждения, без отменённых и сторнированных. Оплаты вносятся частями в карточке получателя. Расход без срока оплаты отмечен «срок не задан» и просроченным не считается. Стоимость товара видна только с правом на закупочные цены. Плановые расходы сюда не входят.</p>
        <div className="import-table-wrap"><table className="import-table">
          <thead><tr><th>Получатель</th><th>Валюта</th><th>Начислено</th><th>Оплачено</th><th>Остаток</th><th>Ближайший срок</th><th>Просрочка</th></tr></thead>
          <tbody>{rows.map(row => <tr key={`${row.payee_id}-${row.currency}`} className={row.overdue_days ? "has-error" : ""}>
            <td><Link href={payeeHref(row.payee_id)}>{row.payee ?? "Получатель не указан"}</Link><br/><small>открытых расходов: {row.open_expenses}{row.no_due_date ? ` · срок не задан: ${row.no_due_date}` : ""}</small></td>
            <td>{row.currency}</td><td>{money(row.accrued)}</td><td>{money(row.paid)}</td><td><strong>{money(row.rest)}</strong></td>
            <td>{day(row.nearest_due)}</td>
            <td>{row.overdue_days ? <>{row.overdue_days} дн.<br/><small>{money(row.overdue_amount, row.currency)}</small></> : "—"}</td>
          </tr>)}</tbody>
        </table></div>
        {!rows.length && <p className="empty-state">Подтверждённых фактических расходов нет.</p>}
      </section>
    </>}
  </section></main>;
}
