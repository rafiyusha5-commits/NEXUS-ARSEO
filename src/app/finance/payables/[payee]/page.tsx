import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireUser } from "@/lib/auth/access";
import { expenseStatusLabel, expenseTypeLabel, money } from "@/lib/finance/payables";
import { applyAdvance, recordAdvancePayment, recordExpensePayment, setExpenseDueDate } from "../actions";

type Payment = { amount: string; paid_on: string; author: string | null; document: string | null; note: string | null; legacy: boolean; advance?: boolean; created_at: string };
type Advance = { id: string; currency: string; currency_id: string; amount: string; remaining: string; paid_on: string; advance_for: string; note: string | null; author: string | null; applications: Array<{ expense_id: string; amount: string }> };
type Expense = { id: string; type: string; status: string; currency: string; amount: string; paid: string; rest: string; incurred_at: string;
  due_date: string | null; overdue_days: number | null; shipment: string | null; shipment_id: string | null; currency_id?: string; payments: Payment[] };
type Card = { payee: string | null; payment_terms: string | null; can_pay: boolean; can_manage: boolean; can_goods?: boolean; expenses: Expense[]; advances?: Advance[] };

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = (value: string | null) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "—";
const almatyToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());

// One payee: every expense with its payments; partial payments and due dates.
export default async function PayeePage({ params, searchParams }: { params: Promise<{ payee: string }>; searchParams: Promise<{ error?: string; success?: string }> }) {
  const { payee } = await params;
  const notice = await searchParams;
  if (payee !== "none" && !uuid.test(payee)) notFound();
  const { profile, roles, supabase } = await requireUser();
  const [{ data, error }, { data: currencyRows }] = await Promise.all([
    supabase.rpc("payables_payee", { p_payee_id: payee === "none" ? null : payee }),
    supabase.from("currencies").select("id,code").eq("is_active", true).order("code"),
  ]);
  const currencies = (currencyRows ?? []) as Array<{ id: string; code: string }>;
  const card = data as Card | null;
  const open = (card?.expenses ?? []).filter(expense => Number(expense.rest) > 0);
  const closed = (card?.expenses ?? []).filter(expense => Number(expense.rest) <= 0);
  const today = almatyToday();
  const advances = card?.advances ?? [];
  const openAdvances = advances.filter(advance => Number(advance.remaining) > 0);
  const row = (expense: Expense) => <article className="panel admin-section" key={expense.id}>
    <div className="panel-heading"><div><p className="eyebrow">{expenseTypeLabel[expense.type] ?? expense.type} · {expenseStatusLabel[expense.status] ?? expense.status}{expense.shipment && <> · <Link href={`/shipments/${expense.shipment_id}`}>{expense.shipment}</Link></>}</p>
      <h2>{money(expense.amount, expense.currency)}</h2></div>
      <span className={`page-count${expense.overdue_days ? " receivable-overdue" : ""}`}>{expense.overdue_days ? `просрочка ${expense.overdue_days} дн.` : expense.due_date ? `срок ${day(expense.due_date)}` : "срок не задан"}</span></div>
    <div className="operation-facts"><div><small>Дата расхода</small><strong>{day(expense.incurred_at)}</strong></div><div><small>Оплачено</small><strong>{money(expense.paid, expense.currency)}</strong></div><div><small>Остаток</small><strong>{money(expense.rest, expense.currency)}</strong></div></div>
    {expense.payments.length > 0 && <div className="operation-history-list">{expense.payments.map((payment, index) => <article className="operation-history-row" key={index}>
      <time>{day(payment.paid_on)}</time><div><strong>{money(payment.amount, expense.currency)}</strong><small>{payment.legacy ? "внесена до учёта частичных оплат · " : ""}{payment.advance ? "зачтён аванс · " : ""}{payment.author ?? "—"}{payment.document ? ` · ${payment.document}` : ""}{payment.note ? ` · ${payment.note}` : ""}</small></div>
    </article>)}</div>}
    {card?.can_pay && Number(expense.rest) > 0 && ["confirmed", "allocated"].includes(expense.status) && <form action={recordExpensePayment} className="reference-form">
      <input type="hidden" name="request_id" value={randomUUID()}/><input type="hidden" name="expense_id" value={expense.id}/><input type="hidden" name="payee" value={payee}/>
      <label>Сумма, {expense.currency}<input name="amount" inputMode="decimal" required defaultValue={expense.rest}/></label>
      <label>Дата оплаты<input type="date" name="paid_on" required max={today} defaultValue={today}/></label>
      <label className="wide-field">Документ-основание и примечание<input name="note" maxLength={1000} placeholder="Например: платёжное поручение № 15"/></label>
      <PendingSubmitButton pendingText="Вносим…" className="primary" type="submit">Внести оплату</PendingSubmitButton>
    </form>}
    {card?.can_pay && Number(expense.rest) > 0 && ["confirmed", "allocated"].includes(expense.status) && openAdvances.some(advance => advance.currency_id === expense.currency_id) && <form action={applyAdvance} className="inline-action">
      <input type="hidden" name="request_id" value={randomUUID()}/><input type="hidden" name="expense_id" value={expense.id}/><input type="hidden" name="payee" value={payee}/>
      <label>Зачесть аванс<select name="advance_id" required>{openAdvances.filter(advance => advance.currency_id === expense.currency_id).map(advance => <option key={advance.id} value={advance.id}>от {day(advance.paid_on)}, остаток {money(advance.remaining, advance.currency)}</option>)}</select></label>
      <label>Сумма<input name="amount" inputMode="decimal" required defaultValue={String(Math.min(Number(expense.rest), Math.max(...openAdvances.filter(advance => advance.currency_id === expense.currency_id).map(advance => Number(advance.remaining)))))}/></label>
      <PendingSubmitButton pendingText="Зачитываем…" className="secondary" type="submit">Зачесть</PendingSubmitButton>
    </form>}
    {card?.can_manage && Number(expense.rest) > 0 && <form action={setExpenseDueDate} className="inline-action">
      <input type="hidden" name="expense_id" value={expense.id}/><input type="hidden" name="payee" value={payee}/>
      <label>Срок оплаты<input type="date" name="due_date" defaultValue={expense.due_date ?? ""}/></label>
      <PendingSubmitButton pendingText="Сохраняем…" className="secondary" type="submit">Сохранить срок</PendingSubmitButton>
    </form>}
  </article>;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="payables"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Кредиторка</p><h1>{card?.payee ?? "Получатель не указан"}</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/finance/payables">К реестру</Link></div></header>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}{notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {error && <div className="setup-notice">Кредиторка недоступна: нужно право «Финансы: просмотр».</div>}
    {card?.payment_terms && <p className="form-help">Условия оплаты перевозчика из справочника перевозок: {card.payment_terms}. Срок оплаты вводится вручную.</p>}
    {!error && <>
      <p className="form-help">Оплата вносится частями: сумма оплат не может превысить сумму расхода. Частично оплаченный расход нельзя отменить — только сторнировать в разделе расходов; внесённые оплаты остаются в истории.</p>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">До появления расхода в Nexus</p><h2>Авансы</h2></div><span className="page-count">{openAdvances.length} с остатком</span></div>
        <p className="form-help">Аванс относится к получателю и зачитывается в его расходы той же валюты. Остаток аванса показан рядом с долгом и сам с долгом не сворачивается.</p>
        <div className="reference-list">{advances.map(advance => <article className="reference-row" key={advance.id}><div><strong>{money(advance.amount, advance.currency)} от {day(advance.paid_on)}</strong><small>{advance.advance_for === "goods" ? "за товар" : "за услуги"} · {advance.author ?? "—"}{advance.note ? ` · ${advance.note}` : ""}</small></div><span className="reference-meta">{Number(advance.remaining) > 0 ? `остаток ${money(advance.remaining, advance.currency)}` : "зачтён полностью"}</span></article>)}</div>
        {!advances.length && <p className="empty-state">Авансов нет.</p>}
        {card?.can_pay && payee !== "none" && <form action={recordAdvancePayment} className="reference-form">
          <input type="hidden" name="request_id" value={randomUUID()}/><input type="hidden" name="payee_id" value={payee}/><input type="hidden" name="payee" value={payee}/>
          <label>Сумма аванса<input name="amount" inputMode="decimal" required/></label>
          <label>Валюта<select name="currency_id" required>{currencies.map(currency => <option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label>
          <label>Дата оплаты<input type="date" name="paid_on" required max={today} defaultValue={today}/></label>
          <label>За что<select name="advance_for" defaultValue="services"><option value="services">услуги (перевозка, брокер и т. п.)</option>{card.can_goods && <option value="goods">товар</option>}</select></label>
          <label className="wide-field">Документ-основание и примечание<input name="note" maxLength={1000}/></label>
          <PendingSubmitButton pendingText="Вносим…" className="primary" type="submit">Внести аванс</PendingSubmitButton>
        </form>}
      </section>
      <h2>К оплате</h2>{open.map(row)}{!open.length && <p className="empty-state">Неоплаченных расходов нет.</p>}
      {closed.length > 0 && <><h2>Оплачено</h2>{closed.map(row)}</>}
    </>}
  </section></main>;
}
