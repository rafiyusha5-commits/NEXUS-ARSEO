import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { createCounterparty } from "./actions";

export default async function CounterpartiesPage({ searchParams }: { searchParams: Promise<{error?: string; success?: string}> }) {
  const { profile, roles, supabase } = await requirePageUser();
  const params = await searchParams;
  const { data: buyers, error } = await supabase.from("counterparties")
    .select("id,legal_name,short_name,country,tax_id,min_remaining_shelf_life_pct,status")
    .contains("roles", ["customer"]).order("legal_name");
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="counterparties"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Справочники · Продажи</p><h1>Покупатели</h1></div><div className="topbar-actions"><span className="page-count">{buyers?.length ?? 0} организаций</span><Link className="ghost button-link" href="/counterparties/import">Импорт из файла</Link></div></header>
    <WorkflowHelp section="counterparties"/>
    {params.error&&<div className="login-error admin-message">{params.error}</div>}{params.success&&<div className="login-success admin-message">{params.success}</div>}
    {error&&<div className="setup-notice"><strong>{publicErrorMessage(error,"Не удалось загрузить покупателей.")}</strong></div>}
    <details className="panel admin-section create-disclosure"><summary><span><small>Новая запись</small><strong>Добавить покупателя</strong></span><b aria-hidden="true">+</b></summary><div className="create-disclosure-body">
      <form action={createCounterparty} className="reference-form counterparty-form"><input type="hidden" name="roles" value="customer"/>
        <label className="wide-field">Юридическое название<input name="legal_name" required/></label><label>Короткое название<input name="short_name"/></label>
        <label>Страна<input name="country" required maxLength={2} placeholder="KZ"/></label><label>БИН / ИНН / VAT<input name="tax_id"/></label>
        <label>Язык<select name="preferred_locale" defaultValue="ru"><option value="ru">Русский</option><option value="kk">Казахский</option><option value="en">Английский</option></select></label>
        <label>Мин. остаточный срок годности, %<input name="min_shelf_life" type="number" min="0" max="100" step="0.01"/></label>
        <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit" disabled={Boolean(error)}>Добавить покупателя</PendingSubmitButton>
      </form></div></details>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Клиенты ARSEO</p><h2>Реестр покупателей</h2></div></div><div className="reference-list">
      {buyers?.map(party=><Link className="reference-row counterparty-row-link" href={`/counterparties/${party.id}`} key={party.id}><div><strong>{party.short_name||party.legal_name}</strong><small>{party.legal_name}{party.tax_id?` · ${party.tax_id}`:""}</small></div><div className="tag-list"><span className="reference-tag">Покупатель</span>{party.status!=="active"&&<span className="reference-tag accent">{party.status==="archived"?"Архив":"Приостановлен"}</span>}</div><span className="reference-meta">{party.country}{party.min_remaining_shelf_life_pct!=null?` · ОСГ ≥ ${party.min_remaining_shelf_life_pct}%`:""} · Открыть →</span></Link>)}
      {!error&&!buyers?.length&&<p className="empty-state">Покупатели пока не добавлены.</p>}
    </div></section>
  </section></main>;
}
