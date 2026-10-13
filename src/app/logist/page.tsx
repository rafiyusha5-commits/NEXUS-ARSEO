import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { LogistProposalList } from "@/components/logist/logist-proposal-list";
import { PendingSubmitButton } from "@/components/pending-submit-button";
import { requireUser } from "@/lib/auth/access";
import { KIND_LABEL, STATUS_LABEL, groupByShipment, parseProposals } from "@/lib/logist/proposals";
import { loadPermissions } from "@/lib/permissions";
import { runLogistAction } from "./actions";

const dateTime = (value: string) => new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

// Agent «Логист»: logistics actions prepared from the state of active shipments. Nothing happens until an
// employee accepts a proposal; accepting runs the same function as the employee's own button, with their rights.
export default async function LogistPage({ searchParams }: { searchParams: Promise<{ logist_error?: string; logist_success?: string }> }) {
  const notices = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["shipments.view", "documents.view"] as const);
  const allowed = permissions["shipments.view"] && permissions["documents.view"];
  const select = "id,shipment_id,kind,title,reason,status,created_at,decided_at,decision_note,shipment:shipments(shipment_number,project_code),decider:profiles!logist_proposals_decided_by_fkey(full_name)";
  const [{ data: pendingRows, error }, { data: decidedRows }] = allowed ? await Promise.all([
    supabase.from("logist_proposals").select(select).eq("status", "pending").order("created_at").limit(200),
    supabase.from("logist_proposals").select(select).in("status", ["accepted", "rejected"]).order("decided_at", { ascending: false }).limit(30),
  ]) : [{ data: null, error: null }, { data: null }];
  const pending = parseProposals(pendingRows);
  const decided = parseProposals(decidedRows);
  const groups = groupByShipment(pending);

  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="logist"/><section className="workspace admin-workspace" id="logist">
    <header className="topbar"><div><p className="eyebrow">Агент «Логист»</p><h1>Предложения Логиста</h1></div><div className="topbar-actions">
      {allowed && <form action={runLogistAction}><input type="hidden" name="back" value="/logist"/><PendingSubmitButton className="primary" pendingText="Проверяем поставки…">Проверить активные поставки</PendingSubmitButton></form>}
    </div></header>
    {notices.logist_error && <div className="login-error admin-message" role="status">{notices.logist_error}</div>}
    {notices.logist_success && <div className="login-success admin-message" role="status">{notices.logist_success}</div>}
    {!allowed && <div className="empty-state">Нужны права «Поставки: просмотр» и «Документы: просмотр». Обратитесь к администратору.</div>}
    {allowed && error && <div className="setup-notice">Предложения недоступны. Если модуль ещё не подключён, примените миграцию <strong>202609277400_logist_assistant.sql</strong>.</div>}
    {allowed && !error && <>
      <section className="panel admin-section"><p className="form-help">Логист смотрит на активные поставки и готовит действия: завершить этап, когда все документы этапа на месте; привязать документ к автомобилю по госномеру; поставить задачу, если машина не прибыла в срок или этап просрочен. Сам он ничего не меняет — действие выполняется только после «Принять», от вашего имени и с вашими правами. Отклонённое предложение не повторяется.</p></section>
      <section className="shipment-summary-grid">
        <article className="summary-card"><p>Ждут решения</p><strong>{pending.length}</strong><small>в {groups.length} поставках</small></article>
        {Object.entries(KIND_LABEL).map(([kind, label]) => <article className="summary-card" key={kind}><p>{label}</p><strong>{pending.filter(proposal => proposal.kind === kind).length}</strong><small>предложений</small></article>)}
      </section>
      {!groups.length && <section className="panel admin-section"><p className="empty-state">Предложений нет. Нажмите «Проверить активные поставки», чтобы Логист посмотрел на них сейчас.</p></section>}
      {groups.map(group => <section className="panel admin-section" key={group.shipmentId}>
        <div className="panel-heading"><div><p className="eyebrow">Поставка</p><h2><Link href={`/shipments/${group.shipmentId}`}>{group.label}</Link></h2></div><span className="page-count">{group.proposals.length}</span></div>
        <LogistProposalList proposals={group.proposals} back="/logist"/>
      </section>)}
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Журнал</p><h2>Последние решения</h2></div><span className="page-count">{decided.length}</span></div>
        {decided.length ? <div className="operation-history-list">{decided.map(proposal => <article className="operation-history-row" key={proposal.id}>
          <time>{proposal.decided_at ? dateTime(proposal.decided_at) : "—"}</time>
          <div><strong>{STATUS_LABEL[proposal.status] ?? proposal.status}: {proposal.title}</strong><small>{proposal.shipment?.shipment_number ?? ""}{proposal.decision_note ? ` · ${proposal.decision_note}` : ""}</small></div>
          <small>{proposal.decider?.full_name ?? "—"}</small>
        </article>)}</div> : <p className="empty-state">Решений пока не было.</p>}
      </section>
    </>}
  </section></main>;
}
