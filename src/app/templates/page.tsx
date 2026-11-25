import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { TemplateCreateForm } from "@/components/template-create-form";
import { requirePageUser } from "@/lib/auth/access";
import { DOCUMENT_FILE_ACCEPT, DOCUMENT_FILE_TYPES_LABEL, MAX_DOCUMENT_FILE_SIZE_LABEL } from "@/lib/documents/files.ts";
import { formatDateTime } from "@/lib/documents/labels.ts";
import { sanitizeSearchTerm } from "@/lib/documents/rules.ts";
import { TEMPLATE_DIRECTIONS, TEMPLATE_LANGUAGES, TEMPLATE_STATUSES, templateDirectionLabel, templateLanguageLabel, templateStatusLabel } from "@/lib/templates/rules.ts";
import { loadTemplatePermissions } from "@/lib/templates/supabase-gateway.ts";
import { createTemplateAction } from "./actions";

type SearchParams = { q?: string; type?: string; direction?: string; language?: string; status?: string; active?: string; error?: string; success?: string };
type Row = {
  id: string; name: string; language: string; flow_direction: string; purpose: string | null; status: string; is_active: boolean;
  versions: { id: string; version_number: number; is_current: boolean }[];
  current_version: number; updated_at: string;
  type: { name_ru: string } | { name_ru: string }[] | null;
  counterparty: { legal_name: string; short_name: string | null } | { legal_name: string; short_name: string | null }[] | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);

export default async function TemplatesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requirePageUser();
  const can = await loadTemplatePermissions(supabase);

  const { data: types, error: typesError } = await supabase.from("document_types").select("id, name_ru, is_active").order("sort_order");
  const search = sanitizeSearchTerm(params.q);
  const typeFilter = UUID.test(params.type ?? "") ? params.type! : "";
  const languageFilter = (TEMPLATE_LANGUAGES as readonly string[]).includes(params.language ?? "") ? params.language! : "";
  const directionFilter = (TEMPLATE_DIRECTIONS as readonly string[]).includes(params.direction ?? "") ? params.direction! : "";
  const statusFilter = (TEMPLATE_STATUSES as readonly string[]).includes(params.status ?? "") ? params.status! : "";
  const activeFilter = params.active === "yes" || params.active === "no" ? params.active : "";

  let templates: Row[] = [];
  let listError: string | null = null;
  if (can.view && !typesError) {
    let query = supabase
      .from("document_templates")
      .select("id, name, language, flow_direction, purpose, status, is_active, current_version, updated_at, versions:document_template_versions(id,version_number,is_current), type:document_types(name_ru), counterparty:counterparties(legal_name, short_name)")
      .order("updated_at", { ascending: false })
      .limit(300);
    if (typeFilter) query = query.eq("document_type_id", typeFilter);
    if (languageFilter) query = query.eq("language", languageFilter);
    if (directionFilter) query = query.eq("flow_direction", directionFilter);
    if (statusFilter) query = query.eq("status", statusFilter);
    else query = query.neq("status", "archived");
    if (activeFilter) query = query.eq("is_active", activeFilter === "yes");
    if (search) query = query.or(`name.ilike.*${search}*,purpose.ilike.*${search}*`);
    const { data, error } = await query;
    templates = (data ?? []) as unknown as Row[];
    listError = error?.message ?? null;
  }

  const { data: counterparties } = can.create
    ? await supabase.from("counterparties").select("id, legal_name, short_name, roles").eq("status", "active").order("legal_name").limit(500)
    : { data: [] };
  const migrationMissing = Boolean(listError && /document_templates|schema cache/.test(listError));
  const hasFilters = Boolean(search || typeFilter || directionFilter || languageFilter || statusFilter || activeFilter);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="templates" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Документооборот</p><h1>Библиотека образцов</h1></div>
          <div className="topbar-actions">
            {can.create && <a className="primary button-link" href="#create">+ Загрузить образец</a>}
            {can.view && <span className="page-count">{templates.length} в выборке</span>}
          </div>
        </header>
    <WorkflowHelp section="templates"/>
        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}
        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">Как это работает</p><h2>Образец не является готовым документом поставки</h2></div></div>
          <p className="form-help">Загрузите правильно оформленный CMR, ТТН, упаковочный лист или карту ввода один раз. При работе с поставкой система создаст отдельную копию, подставит подтверждённые данные из инвойса, договора-заявки, автомобиля и водителя, а исходный образец останется неизменным.</p>
          <div className="shipment-summary-grid">
            <article className="summary-card"><p>Перевозка</p><strong>CMR и ТТН</strong><small>Данные поставщика, покупателя, маршрута, авто и водителя</small></article>
            <article className="summary-card"><p>Товары</p><strong>Упаковочный лист</strong><small>Позиции, количество, упаковка, нетто и брутто</small></article>
            <article className="summary-card"><p>Покупатели</p><strong>Карты ввода</strong><small>Индивидуальная форма ввода новинок в ассортимент клиента</small></article>
            <article className="summary-card"><p>Товар</p><strong>Стикеры и маркировка</strong><small>Размер, форма и содержание для конкретного товара</small><Link className="text-button" href="/stickers">Открыть макеты →</Link></article>
          </div>
        </section>
        {migrationMissing && (
          <div className="setup-notice">Шаблоны ещё не подключены к базе. Администратору: примените миграцию <strong>202609271700_document_templates_listing_cards.sql</strong> (docs/templates-listing-cards.md).</div>
        )}

        {!can.view && !migrationMissing && (
          <section className="panel admin-section"><div className="empty-state">Нет доступа к шаблонам. Обратитесь к администратору, чтобы получить право «Шаблоны: просмотр».</div></section>
        )}

        {can.view && !migrationMissing && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Каталог</p><h2>Поиск и фильтры</h2></div>
              {hasFilters && <Link className="text-button" href="/templates">Сбросить фильтры</Link>}
            </div>
            <form className="doc-filters" method="get">
              <label className="doc-filter-search">Поиск<input name="q" defaultValue={search} placeholder="Название или назначение" /></label>
              <label>Тип документа<select name="type" defaultValue={typeFilter}>
                <option value="">Все типы</option>
                {(types ?? []).map((type) => <option value={type.id} key={type.id}>{type.name_ru}</option>)}
              </select></label>
              <label>Применение<select name="direction" defaultValue={directionFilter}>
                <option value="">Все области</option>
                {TEMPLATE_DIRECTIONS.map((direction) => <option value={direction} key={direction}>{templateDirectionLabel[direction]}</option>)}
              </select></label>
              <label>Язык<select name="language" defaultValue={languageFilter}>
                <option value="">Все языки</option>
                {TEMPLATE_LANGUAGES.map((code) => <option value={code} key={code}>{templateLanguageLabel[code]}</option>)}
              </select></label>
              <label>Статус<select name="status" defaultValue={statusFilter}>
                <option value="">Черновики и утверждённые</option>
                {TEMPLATE_STATUSES.map((status) => <option value={status} key={status}>{templateStatusLabel[status]}</option>)}
              </select></label>
              <label>Активность<select name="active" defaultValue={activeFilter}>
                <option value="">Все</option><option value="yes">Включённые</option><option value="no">Отключённые</option>
              </select></label>
              <button className="primary" type="submit">Показать</button>
            </form>
            {listError && !migrationMissing && <div className="login-error admin-message">Не удалось загрузить библиотеку образцов.</div>}
            <div className="doc-list">
              {templates.map((template) => {
                const file = template.versions.find(version => version.is_current && version.version_number === template.current_version);
                const counterparty = one(template.counterparty);
                return (
                  <article className={`doc-row template-row${template.status === "archived" ? " doc-archived" : ""}`} key={template.id}>
                    <div className="doc-main">
                      <span className="doc-type">{templateDirectionLabel[template.flow_direction]} · {one(template.type)?.name_ru ?? "Тип не указан"}</span>
                      <strong>{template.name}</strong>
                      <small>{template.purpose || "Назначение не указано"}{counterparty ? ` · ${counterparty.short_name || counterparty.legal_name}` : ""}</small>
                    </div>
                    <div className="doc-dates"><strong>{templateLanguageLabel[template.language] ?? template.language}</strong><small>язык</small></div>
                    <div className="doc-dates"><strong>версия {template.current_version}</strong><small>{formatDateTime(template.updated_at)}</small></div>
                    <div className="doc-links">
                      <span className={`doc-badge ${template.is_active ? "doc-optional" : "doc-archive-badge"}`}>{template.is_active ? "Включён" : "Отключён"}</span>
                    </div>
                    <div className="doc-meta">
                      <span className={`doc-badge template-status-${template.status}`}>{templateStatusLabel[template.status] ?? template.status}</span>
                    </div>
                    <span className="document-actions"><Link href={`/templates/${template.id}`}>Открыть карточку</Link>
                      {can.export && file && <a href={`/templates/${template.id}/download?version=${file.id}`}>Скачать оригинал</a>}
                    </span>
                  </article>
                );
              })}
              {!templates.length && !listError && (
                <div className="empty-state">{hasFilters ? "По заданным условиям образцов нет." : "Образцов пока нет. Загрузите первый готовый документ с помощью формы ниже."}</div>
              )}
            </div>
          </section>
        )}

        {can.create && !migrationMissing && (
          <section className="panel admin-section" id="create">
            <div className="panel-heading"><div><p className="eyebrow">Новый образец</p><h2>Загрузить готовый документ и задать правило</h2></div></div>
            <TemplateCreateForm
              action={createTemplateAction}
              types={types ?? []}
              parties={counterparties ?? []}
              accept={DOCUMENT_FILE_ACCEPT}
              fileTypesLabel={DOCUMENT_FILE_TYPES_LABEL}
              maxFileSizeLabel={MAX_DOCUMENT_FILE_SIZE_LABEL}
            />
          </section>
        )}
      </section>
    </main>
  );
}
