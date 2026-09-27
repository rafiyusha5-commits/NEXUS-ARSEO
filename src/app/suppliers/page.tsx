import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { createSupplier } from "./actions";

const roleNames: Record<string,string> = { manufacturer: "Производитель", supplier: "Поставщик" };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<{error?:string;success?:string}> }) {
  const { profile, roles, supabase } = await requireUser();
  const params = await searchParams;
  const { data: suppliers, error } = await supabase.from("counterparties")
    .select("id, legal_name, short_name, roles, country, tax_id, status")
    .overlaps("roles", ["manufacturer", "supplier"]).order("legal_name");
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="suppliers" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Фаза 1 · Справочники</p><h1>Поставщики</h1></div><span className="page-count">{suppliers?.length ?? 0} поставщиков</span></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}{params.success && <div className="login-success admin-message">{params.success}</div>}
      {error && <div className="setup-notice">Не удалось загрузить поставщиков: {error.message}</div>}
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Новая запись</p><h2>Добавить поставщика</h2></div></div>
        <form action={createSupplier} className="reference-form">
          <label>Юридическое название<input name="legal_name" required /></label><label>Короткое название<input name="short_name" /></label>
          <label>Тип<select name="role" required defaultValue="manufacturer"><option value="manufacturer">Завод-изготовитель</option><option value="supplier">Поставщик</option></select></label>
          <label>Страна<input name="country" required maxLength={2} placeholder="FI" /></label><label>VAT / ИНН<input name="tax_id" /></label>
          <label>Язык<select name="preferred_locale" defaultValue="en"><option value="en">Английский</option><option value="ru">Русский</option><option value="kk">Казахский</option></select></label>
          <button className="primary" type="submit" disabled={Boolean(error)}>Добавить</button>
        </form>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Закупки</p><h2>Заводы и поставщики</h2></div></div><div className="reference-list">
        {(suppliers ?? []).map(party=><article className="reference-row" key={party.id}><div><strong>{party.short_name || party.legal_name}</strong><small>{party.legal_name}{party.tax_id ? ` · ${party.tax_id}`:""}</small></div>
          <div className="tag-list">{party.roles.filter((role:string)=>roleNames[role]).map((role:string)=><span className="reference-tag" key={role}>{roleNames[role]}</span>)}{party.status !== "active" && <span className="reference-tag accent">{party.status === "archived" ? "Архив" : "Приостановлен"}</span>}</div><span className="reference-meta">{party.country}</span></article>)}
        {!error && !suppliers?.length && <p className="empty-state">Поставщики ещё не добавлены.</p>}
      </div></section>
    </section>
  </main>;
}
