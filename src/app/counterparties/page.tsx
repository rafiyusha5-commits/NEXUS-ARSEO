import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { createCounterparty } from "./actions";

const roleNames: Record<string, string> = {
  customer: "Покупатель",
  manufacturer: "Завод-изготовитель",
  supplier: "Поставщик",
  carrier: "Перевозчик",
  broker: "Таможенный брокер",
  printing_house: "Типография",
  other: "Прочий партнёр",
};

const filters = [
  ["all", "Все"],
  ["customer", "Покупатели"],
  ["supplier", "Поставщики"],
  ["carrier", "Перевозчики"],
  ["broker", "Брокеры"],
  ["printing_house", "Типографии"],
] as const;

export default async function CounterpartiesPage({ searchParams }: { searchParams: Promise<{error?: string; success?: string; type?: string}> }) {
  const { profile, roles, supabase } = await requireUser();
  const params = await searchParams;
  const selectedType = filters.some(([value]) => value === params.type) ? params.type! : "all";
  const { data: counterparties, error } = await supabase
    .from("counterparties")
    .select("id, legal_name, short_name, roles, country, tax_id, min_remaining_shelf_life_pct, status")
    .order("legal_name");
  const visible = (counterparties ?? []).filter((party) => selectedType === "all"
    || (selectedType === "supplier" ? party.roles.some((role: string) => ["supplier", "manufacturer"].includes(role)) : party.roles.includes(selectedType)));

  return <main className="app-shell">
    <AppSidebar profile={profile} roles={roles} active="counterparties" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Справочники</p><h1>Контрагенты</h1></div><div className="topbar-actions"><span className="page-count">{visible.length} организаций</span><Link className="ghost button-link" href="/counterparties/import">Импорт из файла</Link></div></header>
      {params.error && <div className="login-error admin-message">{params.error}</div>}
      {params.success && <div className="login-success admin-message">{params.success}</div>}
      {error && <div className="setup-notice">Не удалось загрузить контрагентов: <strong>{error.message}</strong></div>}

      <nav className="counterparty-tabs" aria-label="Типы контрагентов">
        {filters.map(([value, label]) => <Link className={selectedType === value ? "active" : ""} href={value === "all" ? "/counterparties" : `/counterparties?type=${value}`} key={value}>{label}</Link>)}
      </nav>

      <details className="panel admin-section create-disclosure">
        <summary><span><small>Новая запись</small><strong>Добавить контрагента</strong></span><b aria-hidden="true">+</b></summary>
        <div className="create-disclosure-body">
        <p className="form-help">У одной организации можно отметить несколько ролей. Например, завод одновременно является производителем и поставщиком.</p>
        <form action={createCounterparty} className="reference-form counterparty-form">
          <label className="wide-field">Юридическое название<input name="legal_name" required /></label>
          <label>Короткое название<input name="short_name" /></label>
          <label>Страна<input name="country" required maxLength={2} placeholder="KZ" /></label>
          <label>БИН / ИНН / VAT<input name="tax_id" /></label>
          <label>Язык<select name="preferred_locale" defaultValue="ru"><option value="ru">Русский</option><option value="kk">Казахский</option><option value="en">Английский</option></select></label>
          <label>Мин. ОСГ покупателя, %<input name="min_shelf_life" type="number" min="0" max="100" step="0.01" /></label>
          <fieldset className="counterparty-role-fieldset"><legend>Роли организации</legend>
            <label><input type="checkbox" name="roles" value="customer" /> Покупатель</label>
            <label><input type="checkbox" name="roles" value="manufacturer" /> Завод-изготовитель</label>
            <label><input type="checkbox" name="roles" value="supplier" /> Поставщик</label>
            <label><input type="checkbox" name="roles" value="carrier" /> Перевозчик</label>
            <label><input type="checkbox" name="roles" value="broker" /> Брокер</label>
            <label><input type="checkbox" name="roles" value="printing_house" /> Типография</label>
          </fieldset>
          <button className="primary" type="submit" disabled={Boolean(error)}>Добавить</button>
        </form>
        </div>
      </details>

      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Единый справочник</p><h2>{filters.find(([value]) => value === selectedType)?.[1]}</h2></div></div>
        <div className="reference-list">
          {visible.map((party) => <Link className="reference-row counterparty-row-link" href={`/counterparties/${party.id}`} key={party.id}>
            <div><strong>{party.short_name || party.legal_name}</strong><small>{party.legal_name}{party.tax_id ? ` · ${party.tax_id}` : ""}</small></div>
            <div className="tag-list">{party.roles.filter((role: string) => roleNames[role]).map((role: string) => <span className="reference-tag" key={role}>{roleNames[role]}</span>)}{party.status !== "active" && <span className="reference-tag accent">{party.status === "archived" ? "Архив" : "Приостановлен"}</span>}</div>
            <span className="reference-meta">{party.country}{party.min_remaining_shelf_life_pct != null ? ` · ОСГ ≥ ${party.min_remaining_shelf_life_pct}%` : ""} · Открыть →</span>
          </Link>)}
          {!error && !visible.length && <p className="empty-state">Контрагентов этого типа пока нет.</p>}
        </div>
      </section>
    </section>
  </main>;
}
