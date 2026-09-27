import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { createCounterparty } from "./actions";

const roleNames: Record<string, string> = {
  manufacturer: "Производитель", supplier: "Поставщик", customer: "Клиент",
  carrier: "Перевозчик", broker: "Брокер", printing_house: "Типография", other: "Другое",
};

export default async function CounterpartiesPage({ searchParams }: { searchParams: Promise<{error?: string; success?: string}> }) {
  const { profile, roles, supabase } = await requireUser();
  const params = await searchParams;
  const { data: counterparties, error } = await supabase
    .from("counterparties")
    .select("id, legal_name, short_name, roles, country, tax_id, min_remaining_shelf_life_pct, status")
    .order("legal_name");

  return <main className="app-shell">
    <AppSidebar profile={profile} roles={roles} active="counterparties" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Фаза 1 · Справочники</p><h1>Контрагенты</h1></div><span className="page-count">{counterparties?.length ?? 0} записей</span></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}
      {params.success && <div className="login-success admin-message">{params.success}</div>}
      {error && <div className="setup-notice">Примените миграцию <strong>202609270002_phase1_reference_data.sql</strong> в Supabase.</div>}
      <section className="panel admin-section">
        <div className="panel-heading"><div><p className="eyebrow">Новая запись</p><h2>Добавить контрагента</h2></div></div>
        <form action={createCounterparty} className="reference-form">
          <label>Юридическое название<input name="legal_name" required /></label>
          <label>Короткое название<input name="short_name" /></label>
          <label>Тип<select name="role" required defaultValue=""><option value="" disabled>Выберите</option>{Object.entries(roleNames).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
          <label>Страна<input name="country" required maxLength={2} placeholder="KZ" /></label>
          <label>БИН / ИНН / VAT<input name="tax_id" /></label>
          <label>Язык<select name="preferred_locale" defaultValue="ru"><option value="ru">Русский</option><option value="kk">Казахский</option><option value="en">Английский</option></select></label>
          <label>Мин. ОСГ, %<input name="min_shelf_life" type="number" min="0" max="100" step="0.01" /></label>
          <button className="primary" type="submit" disabled={Boolean(error)}>Добавить</button>
        </form>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Единый реестр</p><h2>Компании и партнёры</h2></div></div>
        <div className="reference-list">
          {(counterparties ?? []).map((party)=><article className="reference-row" key={party.id}>
            <div><strong>{party.short_name || party.legal_name}</strong><small>{party.legal_name}{party.tax_id ? ` · ${party.tax_id}` : ""}</small></div>
            <div className="tag-list">{party.roles.map((role: string)=><span className="reference-tag" key={role}>{roleNames[role] ?? role}</span>)}</div>
            <span className="reference-meta">{party.country}{party.min_remaining_shelf_life_pct != null ? ` · ОСГ ≥ ${party.min_remaining_shelf_life_pct}%` : ""}</span>
          </article>)}
          {!error && !counterparties?.length && <p className="empty-state">Контрагенты ещё не добавлены.</p>}
        </div>
      </section>
    </section>
  </main>;
}
