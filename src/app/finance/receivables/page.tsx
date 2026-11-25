import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { OpeningBalanceImport } from "@/components/finance/opening-balance-import";
import { requirePageUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { money, sortByRisk, totalsByCurrency, type ReceivableCustomer } from "@/lib/finance/receivables";

const almatyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());

// Who owes what: the debt of every customer by currency, split into not yet due and overdue by age.
export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const { profile, roles, supabase } = await requirePageUser();
  const notice = await searchParams;
  const [permissions, { data, error }, { count: unmatched }] = await Promise.all([
    loadPermissions(supabase, ["receivables.manage"] as const),
    supabase.rpc("customer_receivables"),
    supabase.from("bank_statement_lines").select("id", { count: "exact", head: true }).eq("status", "unmatched"),
  ]);
  const customers = sortByRisk((data ?? []) as ReceivableCustomer[]);
  const totals = totalsByCurrency(customers);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="receivables"/><section className="workspace admin-workspace receivables-workspace">
    <header className="topbar"><div><p className="eyebrow">Финансы</p><h1>Дебиторская задолженность</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/finance/bank">Поступления из банка{unmatched ? ` · не разнесено ${unmatched}` : ""}</Link></div></header>
    <WorkflowHelp section="receivables"/>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}
    {notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {error && <div className="setup-notice">Дебиторка недоступна: нужно право «Дебиторка: просмотр» или миграция <strong>202609277600_receivables.sql</strong>.</div>}
    {!error && <>
      <section className="shipment-summary-grid">
        {totals.map(total => <article className="summary-card" key={total.currency}><p>Долг покупателей, {total.currency}</p><strong>{money(total.debt)}</strong><small>просрочено {money(total.overdue)}{total.advances ? ` · авансы ${money(total.advances)}` : ""}</small></article>)}
        <article className="summary-card"><p>Должников с просрочкой</p><strong>{customers.filter(customer => customer.aging.some(row => Number(row.overdue) > 0)).length}</strong><small>из {customers.length} покупателей</small></article>
        <article className="summary-card"><p>Не разнесено оплат</p><strong>{unmatched ?? 0}</strong><small><Link href="/finance/bank">разнести вручную</Link></small></article>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">По покупателям</p><h2>Задолженность и просрочка</h2></div><span className="page-count">{customers.length}</span></div>
        <p className="form-help">Срок оплаты отгрузки — по условию «Отсрочка оплаты» договора, иначе по отсрочке в карточке покупателя. Оплаты закрывают самые старые долги. Отрицательный остаток — аванс покупателя.</p>
        <div className="table-wrap"><table className="data-table receivables-table"><thead><tr><th>Покупатель</th><th>Остаток</th><th>Не наступил срок</th><th>1–30 дн.</th><th>31–60</th><th>61–90</th><th>Более 90</th><th>Лимит · отсрочка</th></tr></thead><tbody>
          {customers.flatMap(customer => customer.aging.map((row, index) => <tr key={`${customer.customer_id}-${row.currency}`} className={Number(row.overdue) > 0 ? "receivable-overdue" : ""}>
            <td>{index === 0 && <><Link href={`/finance/receivables/${customer.customer_id}`}><strong>{customer.customer}</strong></Link><small>{customer.tax_id ? `БИН ${customer.tax_id}` : "БИН не указан"}{customer.last_act && customer.last_act.difference !== 0 ? ` · расхождение с актом ${money(customer.last_act.difference, customer.last_act.currency)}` : ""}</small></>}</td>
            <td><strong>{money(row.balance, row.currency)}</strong>{Number(row.balance) < 0 && <small>аванс</small>}</td>
            <td>{money(row.not_due)}</td><td>{money(row.overdue_1_30)}</td><td>{money(row.overdue_31_60)}</td><td>{money(row.overdue_61_90)}</td><td>{money(row.overdue_over_90)}</td>
            <td>{index === 0 && <small>{customer.credit_limit != null ? `лимит ${money(customer.credit_limit, customer.limit_currency)}` : "без лимита"} · {customer.deferral_days != null ? `${customer.deferral_days} дн.` : "отсрочка по договору"}</small>}</td>
          </tr>))}
        </tbody></table></div>
        {!customers.length && <p className="empty-state">Данных пока нет: загрузите сальдо из 1С и выписку банка, или отгрузите заказ.</p>}
      </section>
      {permissions["receivables.manage"] && <section className="panel admin-section"><p className="eyebrow">Начальные данные</p><h2>Сальдо из 1С</h2><OpeningBalanceImport today={almatyToday()}/></section>}
    </>}
  </section></main>;
}
