import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { formatDate, formatDateTime } from "@/lib/documents/labels.ts";
import { CARD_STATUSES, CARD_TYPES, cardStatusLabel, cardTypeLabel } from "@/lib/listing-cards/rules.ts";
import { loadPermissions } from "@/lib/permissions.ts";
import { createCardAction } from "./actions";

type SearchParams = { type?: string; status?: string; customer?: string; all?: string; error?: string; success?: string };
type Row = {
  id: string; card_number: string; version: number; card_type: string; status: string; title: string | null;
  effective_date: string | null; created_at: string;
  customer: { legal_name: string; short_name: string | null } | { legal_name: string; short_name: string | null }[] | null;
  items: { count: number }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);
const PERMISSIONS = ["listing_cards.view", "listing_cards.create"] as const;

export default async function ListingCardsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, PERMISSIONS);

  const typeFilter = (CARD_TYPES as readonly string[]).includes(params.type ?? "") ? params.type! : "";
  const statusFilter = (CARD_STATUSES as readonly string[]).includes(params.status ?? "") ? params.status! : "";
  const customerFilter = UUID.test(params.customer ?? "") ? params.customer! : "";
  const showHistory = params.all === "1";

  let cards: Row[] = [];
  let listError: string | null = null;
  if (can["listing_cards.view"]) {
    let query = supabase
      .from("product_listing_cards")
      .select("id, card_number, version, card_type, status, title, effective_date, created_at, customer:counterparties!product_listing_cards_customer_id_fkey(legal_name, short_name), items:product_listing_card_items(count)")
      .order("created_at", { ascending: false })
      .limit(300);
    if (typeFilter) query = query.eq("card_type", typeFilter);
    if (statusFilter) query = query.eq("status", statusFilter);
    else if (!showHistory) query = query.not("status", "in", "(superseded,cancelled)");
    if (customerFilter) query = query.eq("customer_id", customerFilter);
    const { data, error } = await query;
    cards = (data ?? []) as unknown as Row[];
    listError = error?.message ?? null;
  }
  const migrationMissing = Boolean(listError && /product_listing_cards|schema cache/.test(listError));

  const [{ data: customers }, { data: templates }] = await Promise.all([
    can["listing_cards.view"] || can["listing_cards.create"]
      ? supabase.from("counterparties").select("id, legal_name, short_name").contains("roles", ["customer"]).eq("status", "active").order("legal_name").limit(500)
      : Promise.resolve({ data: [] }),
    can["listing_cards.create"]
      ? supabase.from("document_templates").select("id, name, language").eq("status", "approved").eq("is_active", true).order("name")
      : Promise.resolve({ data: [] }),
  ]);
  const hasFilters = Boolean(typeFilter || statusFilter || customerFilter || showHistory);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="listing-cards" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Клиенты</p><h1>Карты ввода и вывода</h1></div>
          <div className="topbar-actions">
            {can["listing_cards.create"] && !migrationMissing && <a className="primary button-link" href="#create">+ Новая карта</a>}
            {can["listing_cards.view"] && <span className="page-count">{cards.length} в выборке</span>}
          </div>
        </header>
        {params.error && <div className="login-error admin-message">{params.error}</div>}
        {params.success && <div className="login-success admin-message">{params.success}</div>}
        {migrationMissing && (
          <div className="setup-notice">Карты ещё не подключены к базе. Администратору: примените миграцию <strong>202609271700_document_templates_listing_cards.sql</strong> (docs/templates-listing-cards.md).</div>
        )}
        {!can["listing_cards.view"] && !migrationMissing && (
          <section className="panel admin-section"><div className="empty-state">Нет доступа к картам ввода и вывода. Обратитесь к администратору.</div></section>
        )}

        {can["listing_cards.view"] && !migrationMissing && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Реестр</p><h2>Карты клиентов</h2></div>
              {hasFilters && <Link className="text-button" href="/listing-cards">Сбросить фильтры</Link>}
            </div>
            <form className="doc-filters" method="get">
              <label>Тип<select name="type" defaultValue={typeFilter}>
                <option value="">Ввод и вывод</option>
                {CARD_TYPES.map((type) => <option value={type} key={type}>{cardTypeLabel[type]}</option>)}
              </select></label>
              <label>Статус<select name="status" defaultValue={statusFilter}>
                <option value="">Действующие</option>
                {CARD_STATUSES.map((status) => <option value={status} key={status}>{cardStatusLabel[status]}</option>)}
              </select></label>
              <label className="doc-filter-object">Клиент<select name="customer" defaultValue={customerFilter}>
                <option value="">Все клиенты</option>
                {(customers ?? []).map((customer) => <option value={customer.id} key={customer.id}>{customer.short_name || customer.legal_name}</option>)}
              </select></label>
              <label className="check-label"><input type="checkbox" name="all" value="1" defaultChecked={showHistory} /> Показать заменённые и отменённые</label>
              <button className="primary" type="submit">Показать</button>
            </form>
            {listError && <div className="login-error admin-message">Не удалось загрузить карты: {listError}</div>}
            <div className="doc-list">
              {cards.map((card) => {
                const customer = one(card.customer);
                return (
                  <Link className={`doc-row${["superseded", "cancelled"].includes(card.status) ? " doc-archived" : ""}`} href={`/listing-cards/${card.id}`} key={card.id}>
                    <div className="doc-main">
                      <span className="doc-type">{cardTypeLabel[card.card_type] ?? card.card_type}</span>
                      <strong>{card.card_number} · версия {card.version}</strong>
                      <small>{customer ? customer.short_name || customer.legal_name : "Клиент недоступен"}{card.title ? ` · ${card.title}` : ""}</small>
                    </div>
                    <div className="doc-dates"><strong>{formatDate(card.effective_date)}</strong><small>вступает в силу</small></div>
                    <div className="doc-dates"><strong>{card.items?.[0]?.count ?? 0} поз.</strong><small>товаров</small></div>
                    <div className="doc-links"><small>{formatDateTime(card.created_at)}</small></div>
                    <div className="doc-meta"><span className={`doc-badge card-status-${card.status}`}>{cardStatusLabel[card.status] ?? card.status}</span></div>
                  </Link>
                );
              })}
              {!cards.length && !listError && (
                <div className="empty-state">{hasFilters ? "По заданным условиям карт нет." : "Карт пока нет."}</div>
              )}
            </div>
          </section>
        )}

        {can["listing_cards.create"] && !migrationMissing && (
          <section className="panel admin-section" id="create">
            <div className="panel-heading"><div><p className="eyebrow">Новая карта</p><h2>Создать черновик карты</h2></div></div>
            {!customers?.length ? (
              <div className="empty-state">Нет активных клиентов. Сначала добавьте клиента в разделе «Контрагенты».</div>
            ) : (
              <form action={createCardAction} className="doc-form">
                <label>Тип карты<select name="card_type" required defaultValue="input">
                  {CARD_TYPES.map((type) => <option value={type} key={type}>{cardTypeLabel[type]}</option>)}
                </select></label>
                <label className="doc-form-wide">Клиент<select name="customer_id" required defaultValue="">
                  <option value="" disabled>Выберите клиента</option>
                  {(customers ?? []).map((customer) => <option value={customer.id} key={customer.id}>{customer.short_name || customer.legal_name}</option>)}
                </select></label>
                <label>Вступает в силу<input name="effective_date" type="date" /></label>
                <label className="doc-form-wide">Название<input name="title" maxLength={200} placeholder="Например: ввод новинок, осень" /></label>
                <label className="doc-form-wide">Форма клиента (шаблон)<select name="template_id" defaultValue="">
                  <option value="">Без шаблона</option>
                  {(templates ?? []).map((template) => <option value={template.id} key={template.id}>{template.name} ({template.language})</option>)}
                </select></label>
                <label className="doc-form-rest">Примечание<textarea name="notes" maxLength={2000} rows={2} /></label>
                <button className="primary" type="submit">Создать черновик</button>
                <p className="form-help doc-form-full">Карта создаётся черновиком. После отправки клиенту её нельзя изменить — изменения вносятся новой версией.</p>
              </form>
            )}
          </section>
        )}
      </section>
    </main>
  );
}
