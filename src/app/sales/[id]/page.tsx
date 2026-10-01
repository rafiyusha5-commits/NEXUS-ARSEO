import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { OperationTabs } from "@/components/operation-tabs";
import { requireUser } from "@/lib/auth/access";
import {
  addCustomerOrderItem,
  cancelCustomerOrder,
  changeGuaranteeStatus,
  confirmCustomerOrder,
  createGuaranteeLetter,
  reserveOrderItemFefo,
  reserveOrderItemOverride,
} from "../actions";

function one<T>(value: T | T[] | null | undefined) {
  return Array.isArray(value) ? value[0] : value ?? undefined;
}

function localName(value: unknown) {
  if (!value || typeof value !== "object") return "—";
  const row = value as Record<string, unknown>;
  return String(row.ru ?? row.en ?? "—");
}

function formatDate(value: string | null | undefined) {
  return value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "—";
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

const units: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
const statuses: Record<string, string> = { draft: "Черновик", reserved: "Зарезервирован", confirmed: "Подтверждён", shipped: "Отгружен", cancelled: "Отменён" };
const guaranteeStatuses: Record<string, string> = { draft: "Черновик", approved: "Утверждено", sent: "Отправлено", accepted: "Принято клиентом", rejected: "Отклонено", cancelled: "Отменено" };

export default async function SalePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string; tab?: string }>;
}) {
  const { id } = await params;
  const notices = await searchParams;
  const { profile, roles, supabase } = await requireUser();
  const { data: sale } = await supabase
    .from("sales")
    .select("*,customer:counterparties(short_name,legal_name,min_remaining_shelf_life_pct),warehouse:warehouses(code,name),currency:currencies(code)")
    .eq("id", id)
    .maybeSingle();
  if (!sale) notFound();

  const [{ data: items }, { data: products }, { data: balances }, { data: letters }] = await Promise.all([
    supabase.from("sale_items").select("*,product:products(internal_sku,name,brand),reservations:inventory_reservations(id,batch_id,quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,status,batch:inventory_batches(batch_number,expiry_date))").eq("sale_id", id).order("created_at"),
    supabase.from("products").select("id,internal_sku,name,brand,base_uom").eq("status", "active").order("internal_sku"),
    supabase.from("inventory_fifo_status").select("balance_id,product_id,batch_number,expiry_date,quantity_available,uom,shelf_life_percent,batch_status").eq("warehouse_id", sale.warehouse_id).gt("quantity_available", 0).order("expiry_date"),
    supabase.from("guarantee_letters").select("*,items:guarantee_letter_items(id,quantity,remaining_shelf_life_pct,required_shelf_life_pct,batch:inventory_batches(batch_number),sale_item:sale_items(product:products(internal_sku,name)))").eq("sale_id", id).order("created_at", { ascending: false }),
  ]);

  const customer = one(sale.customer);
  const warehouse = one(sale.warehouse);
  const currency = one(sale.currency);
  const editable = ["draft", "reserved"].includes(sale.status);
  const activeReservations = (items ?? []).flatMap((item) =>
    (item.reservations ?? [])
      .filter((reservation: { status: string }) => reservation.status === "active")
      .map((reservation: Record<string, unknown>) => ({ ...reservation, item })),
  );
  const lowShelf = activeReservations.some((reservation) =>
    reservation.item.required_shelf_life_pct != null && Number(reservation.remaining_shelf_life_pct) < Number(reservation.item.required_shelf_life_pct),
  );
  const reservedItemCount = (items ?? []).filter((item) => (item.reservations ?? []).some((reservation: { status: string }) => reservation.status === "active")).length;
  const orderTotal = (items ?? []).reduce((sum, item) => sum + Number(item.quantity) * Number(item.unit_price ?? 0), 0);
  const pricedItems = (items ?? []).filter((item) => item.unit_price != null).length;
  const stageSteps = [
    { label: "Заказ создан", complete: true, current: sale.status === "draft" },
    { label: "Товар зарезервирован", complete: ["reserved", "confirmed", "shipped"].includes(sale.status), current: sale.status === "reserved" },
    { label: "Заказ подтверждён", complete: ["confirmed", "shipped"].includes(sale.status), current: sale.status === "confirmed" },
    { label: "Товар отгружен", complete: sale.status === "shipped", current: sale.status === "shipped" },
  ];
  const history = [
    { at: sale.created_at as string, title: "Заказ создан", detail: sale.sale_number as string },
    ...(sale.confirmed_at ? [{ at: sale.confirmed_at as string, title: "Заказ подтверждён", detail: "Резервы проверены" }] : []),
    ...(sale.cancelled_at ? [{ at: sale.cancelled_at as string, title: "Заказ отменён", detail: sale.cancellation_reason || "Причина не указана" }] : []),
    ...(letters ?? []).flatMap((letter) => [
      { at: letter.created_at as string, title: `Создано гарантийное письмо ${letter.letter_number}`, detail: guaranteeStatuses[letter.status] ?? letter.status },
      ...(letter.approved_at ? [{ at: letter.approved_at as string, title: `Гарантийное письмо ${letter.letter_number} утверждено`, detail: "Документ готов к отправке" }] : []),
      ...(letter.sent_at ? [{ at: letter.sent_at as string, title: `Гарантийное письмо ${letter.letter_number} отправлено`, detail: "Передано клиенту" }] : []),
    ]),
  ].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());

  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="sales"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Заказ покупателя</p><h1>{sale.sale_number}</h1></div><div className="topbar-actions"><span className={`status sale-${sale.status}`}>{statuses[sale.status] ?? sale.status}</span><Link className="ghost button-link" href="/sales">К реестру</Link></div></header>
    {notices.error && <div className="login-error admin-message">{notices.error}</div>}
    {notices.success && <div className="login-success admin-message">{notices.success}</div>}
    <OperationTabs ariaLabel="Разделы заказа покупателя" activeTab={notices.tab} defaultTab="main" tabs={[
      { id: "main", label: "Основное" },
      { id: "items", label: "Товары", badge: items?.length ?? 0 },
      { id: "shipping", label: "Отгрузка", badge: activeReservations.length },
      { id: "documents", label: "Документы", badge: letters?.length ?? 0 },
      { id: "payment", label: "Оплата" },
      { id: "stages", label: "Этапы", badge: `${stageSteps.filter((step) => step.complete).length}/${stageSteps.length}` },
      { id: "history", label: "История", badge: history.length },
    ]}>
      <>
        <section className="shipment-summary-grid">
          <article className="summary-card"><p>Клиент</p><strong>{customer?.short_name || customer?.legal_name}</strong><small>ОСГ по справочнику: {customer?.min_remaining_shelf_life_pct == null ? "не задано" : `${customer.min_remaining_shelf_life_pct}%`}</small></article>
          <article className="summary-card"><p>План отгрузки</p><strong>{formatDate(sale.planned_shipment_date)}</strong><small>{warehouse?.code} · {localName(warehouse?.name)}</small></article>
          <article className="summary-card"><p>Сумма заказа</p><strong>{orderTotal.toLocaleString("ru-RU")} {currency?.code ?? ""}</strong><small>Цена указана для {pricedItems} из {items?.length ?? 0} позиций</small></article>
          <article className="summary-card"><p>Контроль ОСГ</p><strong>{lowShelf ? "Нужно письмо" : "В норме"}</strong><small>По активным резервам</small></article>
        </section>
        <section className="panel admin-section"><p className="eyebrow">Реквизиты</p><h2>Условия заказа</h2><div className="operation-facts"><div><small>Дата заказа</small><strong>{formatDate(sale.sale_date)}</strong></div><div><small>Валюта</small><strong>{currency?.code ?? "—"}</strong></div><div><small>Склад отгрузки</small><strong>{warehouse?.code} · {localName(warehouse?.name)}</strong></div><div><small>Примечание</small><strong>{sale.notes || "—"}</strong></div></div></section>
        {sale.status !== "cancelled" && sale.status !== "shipped" && <section className="panel admin-section"><p className="eyebrow">Управление</p><h2>Решение по заказу</h2><div className="order-decision-actions">{sale.status === "reserved" && <form action={confirmCustomerOrder}><input type="hidden" name="sale_id" value={id}/><button className="primary" type="submit">Подтвердить заказ</button></form>}<form action={cancelCustomerOrder} className="inline-action"><input type="hidden" name="sale_id" value={id}/><input name="reason" required placeholder="Причина отмены"/><button className="danger-button" type="submit">Отменить заказ</button></form></div></section>}
      </>
      <>
        {editable && <section className="panel admin-section"><p className="eyebrow">Состав заказа</p><h2>Добавить товар</h2><form action={addCustomerOrderItem} className="reference-form"><input type="hidden" name="sale_id" value={id}/><label>Товар<select name="product_id" required defaultValue=""><option value="" disabled>Выберите товар</option>{products?.map((product) => <option key={product.id} value={product.id}>{product.internal_sku} · {localName(product.name)}{product.brand ? ` · ${product.brand}` : ""}</option>)}</select></label><label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Единица<select name="uom" defaultValue="piece">{Object.entries(units).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Цена<input name="unit_price" type="number" min="0" step="0.0001"/></label><label>Мин. ОСГ, %<input name="required_shelf_life_pct" type="number" min="0" max="100" step="0.01" placeholder="Из карточки клиента"/></label><button className="primary" type="submit">Добавить</button></form></section>}
        <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Заказ покупателя</p><h2>Товары</h2></div><span className="page-count">{items?.length ?? 0}</span></div><div className="reference-list">{(items ?? []).map((item) => {const product = one(item.product);const lineTotal = Number(item.quantity) * Number(item.unit_price ?? 0);return <article className="reference-row" key={item.id}><div><strong>{product?.internal_sku} · {localName(product?.name)}</strong><small>{product?.brand || "Без бренда"} · требование ОСГ {item.required_shelf_life_pct ?? "—"}%</small></div><div><strong>{Number(item.quantity).toLocaleString("ru-RU")} {units[item.uom] ?? item.uom}</strong><small>{item.unit_price == null ? "Цена не указана" : `${Number(item.unit_price).toLocaleString("ru-RU")} × ${Number(item.quantity).toLocaleString("ru-RU")} = ${lineTotal.toLocaleString("ru-RU")} ${currency?.code ?? ""}`}</small></div></article>;})}{!items?.length && <p className="empty-state">Добавьте товары в заказ.</p>}</div></section>
      </>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Склад и FEFO</p><h2>Подготовка к отгрузке</h2></div><span className="page-count">{reservedItemCount} из {items?.length ?? 0} позиций</span></div><p className="form-help">Система резервирует партии с ближайшим сроком годности. Ручной выбор другой партии требует указать причину.</p><div className="reference-list">
        {(items ?? []).map((item) => {const product = one(item.product);const reservations = (item.reservations ?? []).filter((reservation: { status: string }) => reservation.status === "active");const available = (balances ?? []).filter((balance) => balance.product_id === item.product_id && balance.uom === item.uom);const itemReserved = reservations.reduce((sum: number, reservation: { quantity: number }) => sum + Number(reservation.quantity), 0);return <article className="reference-row order-item" key={item.id}><div><strong>{product?.internal_sku} · {localName(product?.name)}</strong><small>Заказано {Number(item.quantity).toLocaleString("ru-RU")} · зарезервировано {itemReserved.toLocaleString("ru-RU")} {units[item.uom] ?? item.uom}</small>{reservations.map((reservation: { id: string; quantity: number; remaining_shelf_life_pct: number; is_fefo_override: boolean; override_reason: string | null; batch: unknown }) => {const batch = one(reservation.batch as { batch_number: string; expiry_date: string } | { batch_number: string; expiry_date: string }[]);const low = item.required_shelf_life_pct != null && Number(reservation.remaining_shelf_life_pct) < Number(item.required_shelf_life_pct);return <small key={reservation.id} className={low ? "danger-text" : ""}>Партия {batch?.batch_number}: {Number(reservation.quantity).toLocaleString("ru-RU")} · ОСГ {reservation.remaining_shelf_life_pct}%{reservation.is_fefo_override ? ` · отклонение: ${reservation.override_reason}` : ""}</small>;})}</div>{editable && <div className="order-actions"><form action={reserveOrderItemFefo}><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="sale_item_id" value={item.id}/><button className="secondary compact" type="submit">Резервировать по FEFO</button></form>{available.length > 0 && <form action={reserveOrderItemOverride} className="inline-action"><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="sale_item_id" value={item.id}/><select name="inventory_balance_id" required defaultValue=""><option value="" disabled>Другая партия</option>{available.map((balance) => <option key={balance.balance_id} value={balance.balance_id}>{balance.batch_number} · {Number(balance.quantity_available)} · до {balance.expiry_date}</option>)}</select><input name="reason" required placeholder="Причина отклонения"/><button className="secondary compact" type="submit">Выбрать</button></form>}</div>}</article>;})}
        {!items?.length && <p className="empty-state">Сначала добавьте товары во вкладке «Товары».</p>}
      </div></section>
      <>
        <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Документы заказа</p><h2>Гарантийные письма</h2></div><span className="page-count">{letters?.length ?? 0}</span></div>{lowShelf && !(letters ?? []).length && editable && <form action={createGuaranteeLetter} className="inline-action"><input type="hidden" name="sale_id" value={id}/><input name="notes" placeholder="Комментарий к письму"/><button className="primary" type="submit">Сформировать черновик</button></form>}{!lowShelf && !(letters ?? []).length && <p className="empty-state">Гарантийное письмо не требуется: ОСГ зарезервированных партий соответствует требованиям клиента.</p>}{letters?.map((letter) => <article className="reference-row" key={letter.id}><div><strong>{letter.letter_number}</strong><small>{guaranteeStatuses[letter.status] ?? letter.status} · позиций: {letter.items?.length ?? 0}</small></div>{letter.status === "draft" && <div className="inline-action"><form action={createGuaranteeLetter}><input type="hidden" name="sale_id" value={id}/><button className="secondary compact">Обновить состав</button></form><form action={changeGuaranteeStatus}><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="letter_id" value={letter.id}/><input type="hidden" name="status" value="approved"/><button className="secondary compact">Утвердить</button></form></div>}{letter.status === "approved" && <form action={changeGuaranteeStatus}><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="letter_id" value={letter.id}/><input type="hidden" name="status" value="sent"/><button className="secondary compact">Отметить отправленным</button></form>}</article>)}</section>
        <section className="panel admin-section"><p className="eyebrow">Архив клиента</p><h2>Счета, договоры и отгрузочные документы</h2><p className="form-help">Документы клиента хранятся в едином журнале и доступны по правам сотрудника.</p><Link className="primary button-link" href={`/documents?object=customer:${sale.customer_id}&link=customer:${sale.customer_id}`}>Открыть документы клиента</Link></section>
      </>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Расчёты с покупателем</p><h2>Оплата</h2></div><span className="page-count">{currency?.code ?? "—"}</span></div><div className="operation-facts"><div><small>Расчётная сумма заказа</small><strong>{orderTotal.toLocaleString("ru-RU")} {currency?.code ?? ""}</strong></div><div><small>Позиции с ценой</small><strong>{pricedItems} из {items?.length ?? 0}</strong></div><div><small>Условия оплаты</small><strong>По договору с клиентом</strong></div><div><small>Фактическая оплата</small><strong>Данные пока не внесены</strong></div></div><p className="form-help">Фактические платежи появятся здесь после подключения банковских выписок и платёжных документов.</p></section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Процесс продажи</p><h2>Этапы заказа</h2></div><span className="page-count">{stageSteps.filter((step) => step.complete).length} из {stageSteps.length}</span></div>{sale.status === "cancelled" && <div className="login-error admin-message">Заказ отменён: {sale.cancellation_reason || "причина не указана"}</div>}<div className="order-stage-list">{stageSteps.map((step, index) => <article className={`order-stage ${step.complete ? "complete" : ""} ${step.current ? "current" : ""}`} key={step.label}><span>{step.complete ? "✓" : index + 1}</span><div><strong>{step.label}</strong><small>{step.complete ? "Выполнено" : step.current ? "Текущий этап" : "Ожидает"}</small></div></article>)}</div></section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Хронология</p><h2>История заказа</h2></div><span className="page-count">{history.length}</span></div><div className="operation-history-list">{history.map((event, index) => <article className="operation-history-row" key={`${event.at}-${index}`}><time>{formatDateTime(event.at)}</time><div><strong>{event.title}</strong><small>{event.detail}</small></div></article>)}</div></section>
    </OperationTabs>
  </section></main>;
}
