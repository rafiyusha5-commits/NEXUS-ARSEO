import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { BankStatementImport } from "@/components/finance/bank-statement-import";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { resolveBankLineAction } from "@/app/finance/receivables/actions";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { LINE_STATUS, MATCHED_HOW, money } from "@/lib/finance/receivables";
import { selectAll } from "@/lib/supabase/select-all";

const day = (value: string | null | undefined) => value ? value.slice(0, 10).split("-").reverse().join(".") : "—";
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;
type Line = {
  id: string; doc_number: string | null; doc_date: string; amount: number; payer_name: string | null; payer_bin: string | null;
  purpose: string | null; status: string; matched_how: string | null; note: string | null; customer_id: string | null;
  currency: unknown; customer: unknown; sale: unknown;
};
const SELECT = "id,doc_number,doc_date,amount,payer_name,payer_bin,purpose,status,matched_how,note,customer_id,currency:currencies(code),customer:counterparties(short_name,legal_name),sale:sales(id,sale_number)";

// Incoming payments from the bank statements: loading a statement, and matching what was not matched by BIN or order number.
export default async function BankPaymentsPage({ searchParams }: { searchParams: Promise<{ error?: string; success?: string }> }) {
  const { profile, roles, supabase } = await requireUser();
  const notice = await searchParams;
  const [permissions, { data: open, error }, { data: recent }, { data: imports }, { data: customers }, { data: currencies }] = await Promise.all([
    loadPermissions(supabase, ["receivables.manage"] as const),
    supabase.from("bank_statement_lines").select(SELECT).eq("status", "unmatched").order("doc_date", { ascending: false }).limit(300),
    supabase.from("bank_statement_lines").select(SELECT).neq("status", "unmatched").order("resolved_at", { ascending: false, nullsFirst: false }).limit(50),
    supabase.from("bank_statement_imports").select("id,file_name,account_number,period_from,period_to,lines_total,lines_new,lines_matched,created_at").order("created_at", { ascending: false }).limit(10),
    selectAll((from,to)=>supabase.from("counterparties").select("id,short_name,legal_name,tax_id").contains("roles", ["customer"]).neq("status", "archived").order("legal_name").order("id").range(from,to)),
    supabase.from("currencies").select("code").eq("is_active", true).order("code"),
  ]);
  const canManage = permissions["receivables.manage"];
  const unmatched = (open ?? []) as Line[];
  const resolved = (recent ?? []) as Line[];
  const name = (value: unknown) => { const row = one(value as { short_name?: string | null; legal_name?: string } | null); return row?.short_name || row?.legal_name || "—"; };
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="bank"/><section className="workspace admin-workspace receivables-workspace">
    <header className="topbar"><div><p className="eyebrow">Финансы</p><h1>Поступления из банка</h1></div><div className="topbar-actions"><Link className="ghost button-link" href="/finance/receivables">Дебиторка</Link></div></header>
    <WorkflowHelp section="bank"/>
    {notice.error && <div className="login-error admin-message">{notice.error}</div>}
    {notice.success && <div className="login-success admin-message">{notice.success}</div>}
    {error && <div className="setup-notice">Раздел недоступен: нужно право «Дебиторка: просмотр» или миграция <strong>202609277600_receivables.sql</strong>.</div>}
    {!error && <>
      {canManage && <section className="panel admin-section"><p className="eyebrow">Выписка</p><h2>Загрузить выписку</h2><BankStatementImport currencies={(currencies ?? []).map(row => row.code as string)}/></section>}
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Требуют решения</p><h2>Не разнесены</h2></div><span className="page-count">{unmatched.length}</span></div>
        <p className="form-help">Платёж разносится автоматически, если БИН плательщика есть в карточке покупателя или в назначении указан номер заказа (SO-…). Остальные укажите вручную; платёж, не относящийся к покупателям, отметьте с причиной.</p>
        <div className="reference-list">{unmatched.map(line => <article className="reference-row reference-row-stack bank-line" key={line.id}>
          <div><strong>{day(line.doc_date)} · {money(line.amount, one(line.currency as { code: string } | null)?.code)} · {line.payer_name ?? "плательщик не указан"}</strong>
            <small>{line.payer_bin ? `БИН ${line.payer_bin}` : "БИН не указан"}{line.doc_number ? ` · п/п № ${line.doc_number}` : ""} · {line.purpose ?? "без назначения"}</small></div>
          {canManage && <div className="bank-line-actions">
            <form action={resolveBankLineAction} className="inline-form"><input type="hidden" name="line_id" value={line.id}/><input type="hidden" name="action" value="match"/>
              <select name="customer_id" required defaultValue="" aria-label="Покупатель"><option value="" disabled>Покупатель</option>{(customers ?? []).map(customer => <option key={customer.id} value={customer.id}>{customer.short_name || customer.legal_name}{customer.tax_id ? ` · ${customer.tax_id}` : ""}</option>)}</select>
              <PendingSubmitButton className="primary compact" pendingText="…">Разнести</PendingSubmitButton></form>
            <form action={resolveBankLineAction} className="inline-form"><input type="hidden" name="line_id" value={line.id}/><input type="hidden" name="action" value="ignore"/>
              <input name="note" required maxLength={500} placeholder="Не покупатель: почему" aria-label="Причина"/>
              <PendingSubmitButton className="secondary compact" pendingText="…">Отметить</PendingSubmitButton></form>
          </div>}
        </article>)}{!unmatched.length && <p className="empty-state">Все поступления разнесены.</p>}</div>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Последние решения</p><h2>Разнесённые и отмеченные</h2></div></div>
        <div className="reference-list">{resolved.map(line => { const sale = one(line.sale as { id: string; sale_number: string } | null); return <article className="reference-row" key={line.id}>
          <div><strong>{day(line.doc_date)} · {money(line.amount, one(line.currency as { code: string } | null)?.code)} · {line.payer_name ?? "—"}</strong>
            <small>{line.status === "matched" ? <>→ {line.customer_id ? <Link href={`/finance/receivables/${line.customer_id}`}>{name(line.customer)}</Link> : "—"} {MATCHED_HOW[line.matched_how ?? ""] ?? ""}{sale ? <> · заказ <Link href={`/sales/${sale.id}?tab=payment`}>{sale.sale_number}</Link></> : null}</> : `${LINE_STATUS[line.status] ?? line.status}: ${line.note ?? ""}`}</small></div>
          {canManage && <form action={resolveBankLineAction}><input type="hidden" name="line_id" value={line.id}/><input type="hidden" name="action" value="reset"/><PendingSubmitButton className="ghost compact" pendingText="…">Отменить</PendingSubmitButton></form>}
        </article>; })}{!resolved.length && <p className="empty-state">Пока ничего не разнесено.</p>}</div>
      </section>
      <section className="panel admin-section"><p className="eyebrow">История загрузок</p><div className="reference-list">{(imports ?? []).map(item => <article className="reference-row" key={item.id}><div><strong>{item.file_name}</strong><small>{item.account_number ?? "счёт не указан"} · {day(item.period_from)} — {day(item.period_to)}</small></div><span className="reference-meta">поступлений {item.lines_total}, новых {item.lines_new}, разнесено {item.lines_matched}</span></article>)}{!imports?.length && <p className="empty-state">Выписки ещё не загружались.</p>}</div></section>
    </>}
  </section></main>;
}
