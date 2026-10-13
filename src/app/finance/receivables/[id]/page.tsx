import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { ENTRY_KIND, money, type CustomerStatement } from "@/lib/finance/receivables";
import { addAdjustmentAction, recordActAction, setCreditTermsAction } from "../actions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (value: string | null | undefined) => value ? value.slice(0, 10).split("-").reverse().join(".") : "—";

// One customer: the ledger with a running balance, ageing, payment terms, adjustments and reconciliation acts.
export default async function CustomerReceivablePage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const notice = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const [permissions, { data, error }, { data: currencies }] = await Promise.all([
    loadPermissions(supabase, ["receivables.manage"] as const),
    supabase.rpc("customer_statement", { p_customer_id: id }),
    supabase.from("currencies").select("code").eq("is_active", true).order("code"),
  ]);
  if (error && /не найден/.test(error.message)) notFound();
  const statement = data as CustomerStatement | null;
  const codes = (currencies ?? []).map(row => row.code as string);
  const canManage = permissions["receivables.manage"];
  const entries = [...(statement?.entries ?? [])].reverse();
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="receivables"/><section className="workspace admin-workspace receivables-workspace">
    <header className="topbar"><div><p className="eyebrow">Дебиторка</p><h1>{statement?.customer ?? "Покупатель"}</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/finance/receivables">К списку</Link></div></header>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}
    {notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {(error || !statement) && <div className="setup-notice">Данные недоступны: нужно право «Дебиторка: просмотр» или миграция <strong>202609277600_receivables.sql</strong>.</div>}
    {statement && <>
      <section className="shipment-summary-grid">
        {statement.aging.map(row => <article className="summary-card" key={row.currency}><p>Остаток, {row.currency}</p><strong>{money(row.balance)}</strong><small>{Number(row.balance) < 0 ? "аванс покупателя" : Number(row.overdue) > 0 ? `просрочено ${money(row.overdue)} · до ${row.max_days_overdue} дн.` : "просрочки нет"}</small></article>)}
        <article className="summary-card"><p>Условия</p><strong>{statement.credit_limit != null ? money(statement.credit_limit, statement.limit_currency) : "Без лимита"}</strong><small>{statement.deferral_days != null ? `отсрочка ${statement.deferral_days} дн., если в договоре не указано иное` : "отсрочка по договору"}</small></article>
      </section>
      {statement.aging.some(row => Number(row.overdue) > 0) && <section className="panel admin-section"><p className="eyebrow">Просрочка по срокам</p><div className="table-wrap"><table className="data-table"><thead><tr><th>Валюта</th><th>Не наступил срок</th><th>1–30 дн.</th><th>31–60</th><th>61–90</th><th>Более 90</th><th>Самый старый срок</th></tr></thead><tbody>
        {statement.aging.map(row => <tr key={row.currency}><td>{row.currency}</td><td>{money(row.not_due)}</td><td>{money(row.overdue_1_30)}</td><td>{money(row.overdue_31_60)}</td><td>{money(row.overdue_61_90)}</td><td>{money(row.overdue_over_90)}</td><td>{day(row.oldest_due)}</td></tr>)}
      </tbody></table></div></section>}
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Взаиморасчёты</p><h2>Журнал</h2></div><span className="page-count">{entries.length}</span></div>
        <p className="form-help">Плюс — долг покупателя, минус — оплата, возврат или уменьшающая корректировка. Операции до даты сальдо 1С уже входят в сальдо.</p>
        <div className="table-wrap"><table className="data-table"><thead><tr><th>Дата</th><th>Операция</th><th>Срок оплаты</th><th>Сумма</th><th>Остаток</th></tr></thead><tbody>
          {entries.map(entry => <tr key={`${entry.kind}-${entry.ref_id}`}>
            <td>{day(entry.entry_date)}</td>
            <td><strong>{ENTRY_KIND[entry.kind] ?? entry.kind}</strong>{entry.kind === "shipment" ? <> · <Link href={`/sales/${entry.ref_id}?tab=payment`}>{entry.ref_number}</Link></> : null}{(entry.kind !== "shipment" || entry.description.includes("без цены")) && <small>{entry.description}</small>}</td>
            <td>{Number(entry.amount) > 0 ? day(entry.due_date) : "—"}</td>
            <td>{money(entry.amount, entry.currency)}</td><td>{money(entry.running)}</td>
          </tr>)}
        </tbody></table></div>
        {!entries.length && <p className="empty-state">Операций пока нет.</p>}
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Акты сверки</p><h2>Сверка с покупателем</h2></div><span className="page-count">{statement.acts.length}</span></div>
        <p className="form-help">Внесите сальдо из подписанного акта: Nexus покажет своё сальдо на ту же дату и расхождение. Исправления вносятся корректировкой с причиной.</p>
        {canManage && <form action={recordActAction} className="reference-form"><input type="hidden" name="customer_id" value={statement.customer_id}/>
          <label>Дата акта<input name="as_of" type="date" required max={statement.today} defaultValue={statement.today}/></label>
          <label>Сальдо по акту<input name="act_balance" inputMode="decimal" required placeholder="0,00"/></label>
          <label>Чьё сальдо<select name="side" defaultValue="debt"><option value="debt">Долг покупателя</option><option value="advance">Аванс покупателя</option></select></label>
          <label>Валюта<select name="currency" defaultValue="KZT">{codes.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
          <label className="wide-field">Комментарий<input name="note" maxLength={500}/></label>
          <PendingSubmitButton className="primary" pendingText="Сверка…">Сверить</PendingSubmitButton></form>}
        <div className="reference-list">{statement.acts.map(act => <article className="reference-row" key={act.id}><div><strong>Акт на {day(act.as_of)} · {money(act.act_balance, act.currency)}</strong><small>Nexus: {money(act.nexus_balance, act.currency)}{act.note ? ` · ${act.note}` : ""}</small></div><span className={`reference-tag ${Number(act.difference) === 0 ? "" : "accent"}`}>{Number(act.difference) === 0 ? "Совпадает" : `Расхождение ${money(act.difference)}`}</span></article>)}</div>
      </section>
      {canManage && <section className="panel admin-section"><p className="eyebrow">Ведение</p><h2>Условия оплаты</h2>
        <form action={setCreditTermsAction} className="reference-form"><input type="hidden" name="customer_id" value={statement.customer_id}/>
          <label>Кредитный лимит<input name="credit_limit" inputMode="decimal" placeholder="без лимита" defaultValue={statement.credit_limit ?? ""}/></label>
          <label>Валюта лимита<select name="limit_currency" defaultValue={statement.limit_currency ?? "KZT"}>{codes.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
          <label>Отсрочка, дней<input name="default_deferral_days" type="number" min="0" max="365" placeholder="по договору" defaultValue={statement.deferral_days ?? ""}/></label>
          <PendingSubmitButton className="primary" pendingText="Сохранение…">Сохранить</PendingSubmitButton></form>
        <p className="form-help">Отсрочка из договора (условие «Отсрочка оплаты», в днях) важнее отсрочки из карточки. Лимит проверяется при подтверждении заказа: сотрудник видит предупреждение и решает, продолжать ли.</p>
      </section>}
      {canManage && <section className="panel admin-section"><p className="eyebrow">Ведение</p><h2>Корректировка</h2>
        <form action={addAdjustmentAction} className="reference-form"><input type="hidden" name="customer_id" value={statement.customer_id}/>
          <label>Дата<input name="entry_date" type="date" required max={statement.today} defaultValue={statement.today}/></label>
          <label>Сумма<input name="amount" inputMode="decimal" required placeholder="0,00"/></label>
          <label>Что делает<select name="direction" defaultValue="decrease"><option value="decrease">Уменьшает долг</option><option value="increase">Увеличивает долг</option></select></label>
          <label>Валюта<select name="currency" defaultValue="KZT">{codes.map(code => <option key={code} value={code}>{code}</option>)}</select></label>
          <label className="wide-field">Причина<input name="reason" required maxLength={500} placeholder="Например: ретро-бонус по акту сверки"/></label>
          <PendingSubmitButton className="primary" pendingText="Запись…">Записать</PendingSubmitButton></form>
      </section>}
    </>}
  </section></main>;
}
