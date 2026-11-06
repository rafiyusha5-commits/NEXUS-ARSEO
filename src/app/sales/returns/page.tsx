import { linkedDocuments, LinkedDocuments } from "@/components/documents/linked-documents";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { RETURN_STATUS } from "@/lib/sales/returns";

const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;

// Registry of customer returns; goods waiting in quarantine come first.
export default async function CustomerReturnsPage() {
  const { profile, roles, supabase } = await requireUser();
  const { data, error } = await supabase.from("customer_returns")
    .select("id,return_number,status,received_at,sale_id,sale:sales(sale_number),customer:counterparties(short_name,legal_name),items:customer_return_items(id,decision)")
    .order("received_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as Array<{ id: string; return_number: string; status: string; received_at: string; sale_id: string; sale: unknown; customer: unknown; items: Array<{ id: string; decision: string | null }> }>;
  const ordered = [...rows].sort((left, right) => Number(right.status === "quarantine") - Number(left.status === "quarantine"));
  const waiting = rows.filter(row => row.status === "quarantine").reduce((sum, row) => sum + row.items.filter(item => !item.decision).length, 0);
  const documents = await linkedDocuments(supabase, "customer_return", rows.map(row => row.id));
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="customer-returns"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Продажи</p><h1>Возвраты от покупателей</h1></div></header>
    {error && <div className="setup-notice">Возвраты недоступны: нужно право «Клиентские заказы: просмотр» или миграция <strong>202609277500_customer_returns.sql</strong>.</div>}
    {!error && <>
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Ждут решения</p><strong>{waiting}</strong><small>позиций в карантине</small></article>
        <article className="summary-card"><p>Возвратов</p><strong>{rows.length}</strong><small>последние 200</small></article>
      </section>
      <section className="panel admin-section"><div className="reference-list">{ordered.map(row => { const customer = one(row.customer as { short_name?: string; legal_name?: string } | null); const sale = one(row.sale as { sale_number?: string } | null); const pending = row.items.filter(item => !item.decision).length; return <article className="reference-row" key={row.id}>
        <div><strong><Link href={`/sales/${row.sale_id}?tab=returns`}>{row.return_number} · {customer?.short_name || customer?.legal_name || "Покупатель"}</Link></strong><LinkedDocuments entries={documents.get(row.id)}/><small>Заказ {sale?.sale_number ?? "—"} · {dateTime(row.received_at)}</small></div>
        <div className="tag-list"><span className={`reference-tag ${row.status === "quarantine" ? "accent" : ""}`}>{RETURN_STATUS[row.status] ?? row.status}</span>{row.status === "quarantine" && <span className="reference-tag">ждут решения: {pending}</span>}</div>
        <span className="reference-meta">позиций: {row.items.length}</span>
      </article>; })}{!rows.length && <p className="empty-state">Возвратов пока не было.</p>}</div></section>
    </>}
  </section></main>;
}
