import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { ListingCardEditForm } from "@/components/listing-card-edit-form";
import { requireUser } from "@/lib/auth/access";
import { formatDate, formatDateTime, localizedName } from "@/lib/documents/labels.ts";
import {
  CARD_UOMS,
  availableCardActions,
  cardStatusLabel,
  cardTypeLabel,
  cardUomLabel,
} from "@/lib/listing-cards/rules.ts";
import { loadPermissions } from "@/lib/permissions.ts";
import {
  addCardItemAction,
  cancelCardAction,
  createCardVersionAction,
  decideCardAction,
  removeCardItemAction,
  submitCardAction,
  updateCardAction,
} from "../actions";

type Named = { full_name: string } | { full_name: string }[] | null;
type Card = {
  id: string; card_number: string; version: number; previous_version_id: string | null; root_card_id: string;
  card_type: string; counterparty_id: string; template_id: string | null; title: string | null; effective_date: string | null;
  notes: string | null; status: string; submitted_at: string | null; decided_at: string | null; decision_comment: string | null;
  cancelled_at: string | null; cancel_reason: string | null; created_at: string;
  counterparty: { legal_name: string; short_name: string | null } | null;
  template: { id: string; name: string; language: string; status: string; flow_direction: string; counterparty_id: string | null } | null;
  creator: Named; submitter: Named; decider: Named; canceller: Named;
};
type Item = {
  id: string; product_id: string; required_quantity: number; uom: string; counterparty_sku: string | null; price: number | null; comment: string | null;
  currency: { code: string } | { code: string }[] | null;
  product: { internal_sku: string; name: unknown; shelf_life_days: number | null; identifiers: { identifier_type: string; value: string }[] } | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T,>(value: T | T[] | null | undefined) => (Array.isArray(value) ? value[0] : value ?? undefined);
const PERMISSIONS = ["listing_cards.view", "listing_cards.create", "listing_cards.update", "listing_cards.archive", "listing_cards.approve", "listing_cards.change_status"] as const;

export default async function ListingCardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  if (!UUID.test(id)) notFound();
  const { profile, roles, supabase } = await requireUser();
  const can = await loadPermissions(supabase, PERMISSIONS);
  if (!can["listing_cards.view"]) notFound();

  const { data } = await supabase
    .from("product_listing_cards")
    .select(
      "id, card_number, version, previous_version_id, root_card_id, card_type, counterparty_id, template_id, title, effective_date, notes, status, " +
        "submitted_at, decided_at, decision_comment, cancelled_at, cancel_reason, created_at, " +
        "counterparty:counterparties!product_listing_cards_counterparty_id_fkey(legal_name, short_name), template:document_templates(id, name, language, status, flow_direction, counterparty_id), " +
        "creator:profiles!product_listing_cards_created_by_fkey(full_name), submitter:profiles!product_listing_cards_submitted_by_fkey(full_name), " +
        "decider:profiles!product_listing_cards_decided_by_fkey(full_name), canceller:profiles!product_listing_cards_cancelled_by_fkey(full_name)",
    )
    .eq("id", id)
    .maybeSingle();
  if (!data) notFound();
  const card = data as unknown as Card;

  const [{ data: chain }, { data: itemRows }] = await Promise.all([
    supabase.from("product_listing_cards").select("id, version, status, previous_version_id, created_at").eq("root_card_id", card.root_card_id).order("version"),
    supabase
      .from("product_listing_card_items")
      .select("id, product_id, required_quantity, uom, counterparty_sku, price, comment, currency:currencies(code), product:products(internal_sku, name, shelf_life_days, identifiers:product_identifiers(identifier_type, value))")
      .eq("card_id", id)
      .order("created_at"),
  ]);
  const items = (itemRows ?? []) as unknown as Item[];
  const hasSuccessor = (chain ?? []).some((version) => version.previous_version_id === card.id);
  const actions = availableCardActions(
    { status: card.status, itemCount: items.length, hasSuccessor },
    {
      create: can["listing_cards.create"],
      update: can["listing_cards.update"],
      archive: can["listing_cards.archive"],
      approve: can["listing_cards.approve"],
      change_status: can["listing_cards.change_status"],
    },
  );
  const editable = actions.includes("edit");

  const [{ data: products }, { data: currencies }, { data: counterparties }, { data: templates }] = await Promise.all([
    editable ? supabase.from("products").select("id, internal_sku, name").eq("status", "active").order("internal_sku").limit(1000) : Promise.resolve({ data: [] }),
    editable ? supabase.from("currencies").select("id, code").eq("is_active", true).order("code") : Promise.resolve({ data: [] }),
    editable ? supabase.from("counterparties").select("id, legal_name, short_name, roles").eq("status", "active").order("legal_name").limit(500) : Promise.resolve({ data: [] }),
    editable ? supabase.from("document_templates").select("id, name, language, flow_direction, counterparty_id").eq("status", "approved").eq("is_active", true).eq("flow_direction", card.card_type).order("name").limit(500) : Promise.resolve({ data: [] }),
  ]);
  const usedProducts = new Set(items.map((item) => item.product_id));
  const counterparty = one(card.counterparty);
  const template = one(card.template);

  return (
    <main className="app-shell">
      <AppSidebar profile={profile} roles={roles} active="listing-cards" />
      <section className="workspace admin-workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{cardTypeLabel[card.card_type] ?? card.card_type} · {counterparty ? counterparty.short_name || counterparty.legal_name : "контрагент недоступен"}</p>
            <h1>{card.card_number} · версия {card.version}</h1>
          </div>
          <div className="topbar-actions">
            <span className={`doc-badge card-status-${card.status}`}>{cardStatusLabel[card.status] ?? card.status}</span>
            <Link className="ghost button-link" href="/listing-cards">К реестру</Link>
          </div>
        </header>
        {notices.error && <div className="login-error admin-message">{notices.error}</div>}
        {notices.success && <div className="login-success admin-message">{notices.success}</div>}
        {card.status !== "draft" && (
          <div className="setup-notice">
            Карта в статусе «{cardStatusLabel[card.status]}» не редактируется.
            {actions.includes("new_version") ? " Чтобы внести изменения, создайте новую версию." : ""}
            {card.status === "superseded" ? " Действующая версия — последняя утверждённая в цепочке ниже." : ""}
          </div>
        )}

        <section className="shipment-summary-grid">
          <article className="summary-card"><p>Вступает в силу</p><strong>{formatDate(card.effective_date)}</strong><small>{card.title || "Без названия"}</small></article>
          <article className="summary-card"><p>Шаблон контрагента</p><strong>{template ? template.name : "—"}</strong><small>{template ? <Link href={`/templates/${template.id}`}>открыть шаблон</Link> : "шаблон не выбран"}</small></article>
          <article className="summary-card"><p>Создал</p><strong>{one(card.creator)?.full_name ?? "—"}</strong><small>{formatDateTime(card.created_at)}</small></article>
          <article className="summary-card">
            <p>Решение контрагента</p>
            <strong>{card.decided_at ? cardStatusLabel[card.status === "superseded" ? "approved_by_customer" : card.status] : card.submitted_at ? "Ожидается" : "—"}</strong>
            <small>{card.decided_at ? `${one(card.decider)?.full_name ?? "—"} · ${formatDateTime(card.decided_at)}` : card.submitted_at ? `отправлена ${formatDateTime(card.submitted_at)}` : "не отправлена"}</small>
          </article>
        </section>
        {card.decision_comment && <p className="doc-description">Комментарий к решению: {card.decision_comment}</p>}
        {card.cancel_reason && <p className="doc-description">Отменена {formatDateTime(card.cancelled_at)} ({one(card.canceller)?.full_name ?? "—"}): {card.cancel_reason}</p>}
        {card.notes && <p className="doc-description">{card.notes}</p>}

        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">Товары</p><h2>Позиции карты</h2></div><span className="page-count">{items.length}</span></div>
          <div className="card-item-list">
            {items.map((item) => {
              const product = one(item.product);
              const ids = Object.fromEntries((product?.identifiers ?? []).map((identifier) => [identifier.identifier_type, identifier.value]));
              return (
                <div className="card-item-row" key={item.id}>
                  <div>
                    <span className="doc-type">{product?.internal_sku ?? "—"}{ids.gtin ? ` · GTIN ${ids.gtin}` : ""}</span>
                    <strong>{localizedName(product?.name)}</strong>
                    <small>{ids.supplier_sku ? `Арт. поставщика ${ids.supplier_sku}` : "Арт. поставщика —"}{product?.shelf_life_days ? ` · срок годности ${product.shelf_life_days} дн.` : ""}</small>
                  </div>
                  <div><strong>{Number(item.required_quantity).toLocaleString("ru-RU")} {cardUomLabel[item.uom] ?? item.uom}</strong><small>требуется</small></div>
                  <div><strong>{item.counterparty_sku ?? "—"}</strong><small>{card.card_type === "input" ? "артикул поставщика" : "артикул покупателя"}</small></div>
                  <div><strong>{item.price !== null ? `${Number(item.price).toLocaleString("ru-RU")} ${one(item.currency)?.code ?? ""}` : "—"}</strong><small>{item.comment || "цена контрагента"}</small></div>
                  {editable ? (
                    <form action={removeCardItemAction}>
                      <input type="hidden" name="card_id" value={card.id} />
                      <input type="hidden" name="item_id" value={item.id} />
                      <button className="ghost compact" type="submit">Удалить</button>
                    </form>
                  ) : <span />}
                </div>
              );
            })}
            {!items.length && <div className="empty-state">В карте ещё нет позиций.{editable ? " Добавьте товары с помощью формы ниже." : ""}</div>}
          </div>

          {actions.includes("add_item") && (
            <form action={addCardItemAction} className="doc-form card-item-form">
              <input type="hidden" name="card_id" value={card.id} />
              <label className="doc-form-wide">Товар<select name="product_id" required defaultValue="">
                <option value="" disabled>Выберите товар</option>
                {(products ?? []).filter((product) => !usedProducts.has(product.id)).map((product) => (
                  <option value={product.id} key={product.id}>{product.internal_sku} · {localizedName(product.name)}</option>
                ))}
              </select></label>
              <label>Требуемое количество<input name="required_quantity" required inputMode="decimal" placeholder="0" /></label>
              <label>Единица<select name="uom" defaultValue="piece">
                {CARD_UOMS.map((uom) => <option value={uom} key={uom}>{cardUomLabel[uom]}</option>)}
              </select></label>
              <label>{card.card_type === "input" ? "Артикул поставщика" : "Артикул покупателя"}<input name="counterparty_sku" maxLength={100} /></label>
              <label>Цена контрагента<input name="price" inputMode="decimal" placeholder="—" /></label>
              <label>Валюта<select name="currency_id" defaultValue="">
                <option value="">—</option>
                {(currencies ?? []).map((currency) => <option value={currency.id} key={currency.id}>{currency.code}</option>)}
              </select></label>
              <label>Комментарий<input name="comment" maxLength={1000} /></label>
              <button className="primary" type="submit">Добавить позицию</button>
              {!products?.length && <p className="form-help doc-form-full">Нет активных товаров. Добавьте товар в разделе «Товары».</p>}
            </form>
          )}
        </section>

        {(actions.includes("submit") || actions.includes("decide") || actions.includes("new_version")) && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Статус</p><h2>Действия с картой</h2></div></div>
            <div className="template-actions">
              {actions.includes("submit") && (
                <form action={submitCardAction}>
                  <input type="hidden" name="card_id" value={card.id} />
                  <button className="primary" type="submit">Отправить контрагенту</button>
                </form>
              )}
              {actions.includes("new_version") && (
                <form action={createCardVersionAction}>
                  <input type="hidden" name="card_id" value={card.id} />
                  <button className="primary" type="submit">Создать новую версию</button>
                </form>
              )}
            </div>
            {card.status === "draft" && !actions.includes("submit") && can["listing_cards.change_status"] && (
              <p className="form-help">Чтобы отправить карту контрагенту, добавьте хотя бы одну позицию.</p>
            )}
            {actions.includes("decide") && (
              <form action={decideCardAction} className="doc-subform card-decision-form">
                <input type="hidden" name="card_id" value={card.id} />
                <label>Решение контрагента<select name="decision" required defaultValue="">
                  <option value="" disabled>Выберите</option>
                  <option value="approved">Контрагент утвердил</option>
                  <option value="rejected">Контрагент отклонил</option>
                </select></label>
                <label>Комментарий (обязателен при отказе)<input name="comment" maxLength={1000} /></label>
                <button className="primary" type="submit">Зафиксировать</button>
              </form>
            )}
          </section>
        )}

        <section className="panel admin-section">
          <div className="panel-heading"><div><p className="eyebrow">История</p><h2>Версии карты</h2></div><span className="page-count">{chain?.length ?? 0}</span></div>
          <div className="doc-version-list">
            {(chain ?? []).map((version) => (
              <div className={`doc-version-row${version.id === card.id ? " is-current" : ""}`} key={version.id}>
                <span className="stage-number">v{version.version}</span>
                <div><strong>{card.card_number} · версия {version.version}</strong><small>{version.previous_version_id ? `на основе версии ${version.version - 1}` : "первая версия"}</small></div>
                <div><strong>{formatDateTime(version.created_at)}</strong><small>создана</small></div>
                <div className="doc-version-actions">
                  <span className={`doc-badge card-status-${version.status}`}>{cardStatusLabel[version.status] ?? version.status}</span>
                  {version.id !== card.id && <Link className="ghost button-link compact" href={`/listing-cards/${version.id}`}>Открыть</Link>}
                </div>
              </div>
            ))}
          </div>
        </section>

        {editable && (
          <section className="panel admin-section">
            <div className="panel-heading"><div><p className="eyebrow">Черновик</p><h2>Изменить карту</h2></div></div>
            <ListingCardEditForm
              action={updateCardAction}
              card={card}
              parties={counterparties ?? []}
              templates={templates ?? []}
            />
          </section>
        )}

        {actions.includes("cancel") && (
          <section className="panel admin-section doc-danger-zone">
            <div className="panel-heading"><div><p className="eyebrow">Отмена</p><h2>Отменить карту</h2></div></div>
            <p className="form-help">Карта не удаляется: она остаётся в истории со статусом «Отменена». После отмены можно создать новую версию.</p>
            <form action={cancelCardAction} className="doc-subform doc-archive-form">
              <input type="hidden" name="card_id" value={card.id} />
              <label>Причина<input name="reason" required minLength={3} maxLength={500} /></label>
              <button className="ghost danger-text" type="submit">Отменить карту</button>
            </form>
          </section>
        )}
      </section>
    </main>
  );
}
