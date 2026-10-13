import Link from "next/link";
import { recordCreditDecisionAction } from "@/app/finance/receivables/actions";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { money, type CreditCheck } from "@/lib/finance/receivables";
import { loadPermissions } from "@/lib/permissions";
import { createClient } from "@/lib/supabase/server";

const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const day = (value: string) => value.slice(0, 10).split("-").reverse().join(".");
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;

async function loadCheck(saleId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("customer_credit_check", { p_sale_id: saleId });
  return { supabase, check: error ? null : data as CreditCheck };
}

// Short warning on the main tab while the order can still be confirmed.
export async function SaleCreditWarning({ saleId, saleStatus }: { saleId: string; saleStatus: string }) {
  if (!["draft", "reserved"].includes(saleStatus)) return null;
  const { check } = await loadCheck(saleId);
  if (!check?.issues.length || check.decisions.length) return null;
  return <div className="setup-notice credit-warning"><strong>Риск по оплате.</strong> {check.issues.map(issue => issue.message.replace(/\.$/, "")).join("; ")}. <Link href={`/sales/${saleId}?tab=payment`}>Решить во вкладке «Оплата»</Link></div>;
}

// The payment tab: the customer's debt, the warning before confirmation and the decision, payments for this order.
export async function SaleCreditPanel({ saleId, saleStatus, currency, orderTotal }: { saleId: string; saleStatus: string; currency: string; orderTotal: number }) {
  const { supabase, check } = await loadCheck(saleId);
  const [permissions, { data: payments }] = await Promise.all([
    loadPermissions(supabase, ["sales.manage", "receivables.view"] as const),
    supabase.from("bank_statement_lines").select("id,doc_number,doc_date,amount,currency:currencies(code)").eq("sale_id", saleId).eq("status", "matched").order("doc_date"),
  ]);
  const paid = (payments ?? []) as { id: string; doc_number: string | null; doc_date: string; amount: number; currency: unknown }[];
  const open = ["draft", "reserved"].includes(saleStatus);
  return <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Расчёты с покупателем</p><h2>Оплата</h2></div><span className="page-count">{currency || "—"}</span></div>
    {!check && <p className="form-help">Данные о долгах покупателя недоступны. Если модуль дебиторки ещё не подключён, примените миграцию <strong>202609277600_receivables.sql</strong>.</p>}
    {check && <>
      <div className="operation-facts">
        <div><small>Сумма заказа</small><strong>{money(check.order_amount ?? orderTotal, check.order_currency || currency)}</strong></div>
        {check.aging.map(row => <div key={row.currency}><small>Долг покупателя, {row.currency}</small><strong>{money(row.balance)}</strong>{Number(row.overdue) > 0 && <small className="danger-text">просрочено {money(row.overdue)}</small>}</div>)}
        {!check.aging.length && <div><small>Долг покупателя</small><strong>Нет</strong></div>}
        <div><small>Условия оплаты</small><strong>По договору с клиентом</strong></div>
      </div>
      {check.issues.length > 0 && <div className="setup-notice credit-warning"><strong>Риск по оплате:</strong> {check.issues.map(issue => issue.message.replace(/\.$/, "")).join("; ")}.</div>}
      {open && check.issues.length > 0 && !check.decisions.length && <>
        <p className="form-help">Выберите действие. <strong>Отложить</strong> — не подтверждайте заказ, пока покупатель не оплатит (или отмените его во вкладке «Основное»). <strong>Продолжить</strong> — укажите причину: решение запишется в заказ, бухгалтерия получит уведомление, после этого заказ можно подтвердить.</p>
        {permissions["sales.manage"] ? <form action={recordCreditDecisionAction} className="credit-decision"><input type="hidden" name="sale_id" value={saleId}/>
          <input name="reason" required maxLength={500} placeholder="Почему продолжаем: договорённость, гарантия оплаты…" aria-label="Причина"/>
          <PendingSubmitButton className="primary" pendingText="Запись…">Продолжить под мою ответственность</PendingSubmitButton></form>
          : <p className="form-help">Решение принимает сотрудник с правом подтверждать заказы.</p>}
      </>}
      {check.decisions.map((decision, index) => <div className="login-success admin-message" key={index}>Продолжено несмотря на риск: {decision.reason} — {decision.decided_by ?? "сотрудник"}, {dateTime(decision.decided_at)}</div>)}
      {paid.length > 0 && <><h3 className="credit-payments-title">Оплаты по этому заказу</h3><div className="reference-list">{paid.map(payment => <div className="reference-row" key={payment.id}><div><strong>{money(payment.amount, one(payment.currency as { code: string } | null)?.code)}</strong><small>{day(payment.doc_date)}{payment.doc_number ? ` · п/п № ${payment.doc_number}` : ""}</small></div></div>)}</div></>}
      {permissions["receivables.view"] && <p className="form-help"><Link href="/finance/receivables">Вся дебиторка</Link> · <Link href="/finance/bank">Поступления из банка</Link></p>}
    </>}
  </section>;
}
