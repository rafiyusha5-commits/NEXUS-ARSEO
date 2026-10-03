import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { ListingCardCreateForm } from "@/components/listing-card-create-form";
import { requireUser } from "@/lib/auth/access";
import { formatDate, formatDateTime } from "@/lib/documents/labels.ts";
import { CARD_STATUSES, cardStatusLabel } from "@/lib/listing-cards/rules.ts";
import { loadPermissions } from "@/lib/permissions.ts";
import { createCardAction } from "./actions";

type SearchParams = { status?: string; counterparty?: string; all?: string; error?: string; success?: string };
type Row = {
  id: string; card_number: string; version: number; card_type: string; status: string; title: string | null;
  effective_date: string | null; created_at: string;
  counterparty: { legal_name: string; short_name: string | null } | { legal_name: string; short_name: string | null }[] | null;
  items: { count: number }[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);
const PERMISSIONS = ["listing_cards.view", "listing_cards.create"] as const;

export default async function ListingCardsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, PERMISSIONS);

  const statusFilter = (CARD_STATUSES as readonly string[]).includes(params.status ?? "") ? params.status! : "";
  const counterpartyFilter = UUID.test(params.counterparty ?? "") ? params.counterparty! : "";
  const showHistory = params.all === "1";

  let cards: Row[] = [];
  let listError: string | null = null;
  if (can["listing_cards.view"]) {
    let query = supabase
      .from("product_listing_cards")
      .select("id, card_number, version, card_type, status, title, effective_date, created_at, counterparty:counterparties!product_listing_cards_counterparty_id_fkey(legal_name, short_name), items:product_listing_card_items(count)")
      .eq("card_type", "output")
      .order("created_at", { ascending: false })
      .limit(300);
    if (statusFilter) query = query.eq("status", statusFilter);
    else if (!showHistory) query = query.not("status", "in", "(superseded,cancelled)");
    if (counterpartyFilter) query = query.eq("counterparty_id", counterpartyFilter);
    const { data, error } = await query;
    cards = (data ?? []) as unknown as Row[];
    listError = error?.message ?? null;
  }
  const migrationMissing = Boolean(listError && /product_listing_cards|schema cache/.test(listError));

  const [{ data: counterparties }, { data: templates }] = await Promise.all([
    can["listing_cards.view"] || can["listing_cards.create"]
      ? supabase.from("counterparties").select("id, legal_name, short_name, roles").eq("status", "active").order("legal_name").limit(500)
      : Promise.resolve({ data: [] }),
    can["listing_cards.create"]
      ? supabase.from("document_templates").select("id, name, language, flow_direction, counterparty_id").eq("status", "approved").eq("is_active", true).order("name")
      : Promise.resolve({ data: [] }),
  ]);
  const hasFilters = Boolean(statusFilter || counterpartyFilter || showHistory);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="listing-cards" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div><p className="eyebrow">Покупатели · Новинки</p><h1>Карты ввода товаров</h1></div>
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
          <section className="panel admin-section"><div className="empty-state">Нет доступа к картам ввода товаров. Обратитесь к администратору.</div></section>
        )}

        {can["listing_cards.view"] && !migrationMissing && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Реестр</p><h2>Карты ввода новинок покупателям</h2></div>
              {hasFilters && <Link className="text-button" href="/listing-cards">Сбросить фильтры</Link>}
            </div>
            <form className="doc-filters" method="get">
              <label>Статус<select name="status" defaultValue={statusFilter}>
                <option value="">Действующие</option>
                {CARD_STATUSES.map((status) => <option value={status} key={status}>{cardStatusLabel[status]}</option>)}
              </select></label>
              <label className="doc-filter-object">Контрагент<select name="counterparty" defaultValue={counterpartyFilter}>
                <option value="">Все контрагенты</option>
                {(counterparties ?? []).map((party) => <option value={party.id} key={party.id}>{party.short_name || party.legal_name}</option>)}
              </select></label>
              <label className="check-label"><input type="checkbox" name="all" value="1" defaultChecked={showHistory} /> Показать заменённые и отменённые</label>
              <button className="primary" type="submit">Показать</button>
            </form>
            {listError && <div className="login-error admin-message">Не удалось загрузить карты ввода.</div>}
            <div className="doc-list">
              {cards.map((card) => {
                const counterparty = one(card.counterparty);
                return (
                  <Link className={`doc-row${["superseded", "cancelled"].includes(card.status) ? " doc-archived" : ""}`} href={`/listing-cards/${card.id}`} key={card.id}>
                    <div className="doc-main">
                      <span className="doc-type">Ввод товара в ассортимент</span>
                      <strong>{card.card_number} · версия {card.version}</strong>
                      <small>{counterparty ? counterparty.short_name || counterparty.legal_name : "Контрагент недоступен"}{card.title ? ` · ${card.title}` : ""}</small>
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
            {!counterparties?.length ? (
              <div className="empty-state">Нет активных покупателей. Сначала добавьте их в справочник покупателей.</div>
            ) : (
              <ListingCardCreateForm action={createCardAction} parties={counterparties ?? []} templates={templates ?? []} />
            )}
          </section>
        )}
      </section>
    </main>
  );
}
