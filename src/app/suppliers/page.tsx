import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { publicErrorMessage } from "@/lib/errors/public-message";
import { createSupplier } from "./actions";

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{error?:string;success?:string}> }) {
  const { profile, roles, supabase } = await requireUser();
  const params = await searchParams;
  const [{data:suppliers,error},{data:links}] = await Promise.all([
    supabase.from("counterparties").select("id,legal_name,short_name,country,tax_id,status").contains("roles",["manufacturer"]).order("legal_name"),
    supabase.from("product_suppliers").select("supplier_id,product_id,status").eq("status","active"),
  ]);
  const counts=new Map<string,number>(); for(const link of links??[]) counts.set(link.supplier_id,(counts.get(link.supplier_id)??0)+1);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="suppliers"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Справочники · Закупки</p><h1>Поставщики</h1></div><div className="topbar-actions"><span className="page-count">{suppliers?.length??0} заводов</span></div></header>
    {params.error&&<div className="login-error admin-message">{params.error}</div>}{params.success&&<div className="login-success admin-message">{params.success}</div>}
    {error&&<div className="setup-notice"><strong>{publicErrorMessage(error,"Не удалось загрузить поставщиков.")}</strong></div>}
    <div className="setup-notice">В этом реестре учитываются только прямые поставщики ARSEO — заводы-производители. Дистрибьюторы из старых поставок остаются в истории.</div>
    <details className="panel admin-section create-disclosure"><summary><span><small>Новая запись</small><strong>Добавить завод-поставщик</strong></span><b aria-hidden="true">+</b></summary><div className="create-disclosure-body">
      <form action={createSupplier} className="reference-form counterparty-form"><label className="wide-field">Юридическое название<input name="legal_name" required/></label><label>Короткое название<input name="short_name"/></label><label>Страна<input name="country" required maxLength={2} placeholder="FI"/></label><label>VAT / налоговый номер<input name="tax_id"/></label><label>Язык<select name="preferred_locale" defaultValue="en"><option value="en">Английский</option><option value="ru">Русский</option><option value="kk">Казахский</option></select></label><button className="primary" type="submit">Добавить завод</button></form>
    </div></details>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Прямые контракты</p><h2>Заводы-поставщики</h2></div></div><div className="reference-list">
      {suppliers?.map(party=><Link className="reference-row counterparty-row-link" href={`/counterparties/${party.id}`} key={party.id}><div><strong>{party.short_name||party.legal_name}</strong><small>{party.legal_name}{party.tax_id?` · ${party.tax_id}`:""}</small></div><div className="tag-list"><span className="reference-tag">Завод-производитель</span><span className="reference-tag">{counts.get(party.id)??0} товаров</span></div><span className="reference-meta">{party.country} · Открыть →</span></Link>)}
      {!error&&!suppliers?.length&&<p className="empty-state">Заводы-поставщики пока не добавлены.</p>}
    </div></section>
  </section></main>;
}
