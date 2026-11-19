import { PendingSubmitButton } from "@/components/pending-submit-button";
import { AdminOrderDateCorrection } from "@/components/sales/admin-order-date-correction";
import { WorkflowHelp } from "@/components/workflow-help";
import { linkedDocuments, LinkedDocuments } from "@/components/documents/linked-documents";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { CustomerReturnsPanel } from "@/components/sales/customer-returns-panel";
import { HistoricalActualReceipt, type ReceiptPreview, type ActualReceipt } from "@/components/sales/historical-actual-receipt";
import { ReservationReplacement } from "@/components/sales/reservation-replacement";
import { replacementPermissions, replacementUnits } from "@/lib/sales/reservation-replacement";
import { OperationTabs } from "@/components/operation-tabs";
import { SaleCreditPanel, SaleCreditWarning } from "@/components/sales/sale-credit-panel";
import { requireUser } from "@/lib/auth/access";
import { convertQuantity, piecesPerUnit } from "@/lib/products/packaging";
import { selectAll } from "@/lib/supabase/select-all";
import { OrderLinePrice, describePriceList, type PriceSnapshot } from "@/components/sales/order-line-price";
import { OrderLinePriceActions } from "@/components/sales/order-line-price-actions";
import {
  addCustomerOrderItem,
  cancelCustomerOrder,
  changeGuaranteeStatus,
  confirmCustomerOrder,
  fulfillCustomerOrder,
  rescheduleCustomerOrder,
  returnCustomerOrderToPreparation,
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
  const { data: canBackdate } = await supabase.rpc("can_record_historical_sale");
  const { data: canCorrectDate } = await supabase.rpc("can_correct_customer_order_date");
  const canMutate = !sale.historical_shipment_date || canBackdate === true;
  const receiptPreview = sale.historical_shipment_date ? await supabase.rpc("historical_sale_receipt_preview", { p_sale_id: id }) : { data: null, error: null };
  const receiptHistory = sale.historical_shipment_date ? await selectAll((from, to) => supabase.from("historical_sale_receipts")
    .select("id,reason,created_at,created_by,snapshot").eq("sale_id", id).order("created_at").order("id").range(from, to)) : { data: [], error: null };
  const { data: fulfillmentPermissions } = await supabase.rpc("my_permissions", { p_codes: [...replacementPermissions, "inventory.move", "guarantee_letters.manage"] });
  const canReplace = canMutate && replacementPermissions.every(code => (fulfillmentPermissions ?? []).includes(code));
  const { data: replacements } = await selectAll((from, to) => supabase.from("sale_reservation_replacements")
    .select("id,created_at,created_by,reason,previous_allocation,new_allocation,actor:profiles(full_name)").eq("sale_id", id).order("created_at").order("id").range(from, to));
  const canFulfill = canMutate && ["sales.manage", "inventory.move"].every(code => (fulfillmentPermissions ?? []).includes(code));
  // What the shipment would stop at, all at once (customer_order_shipping_blockers); only a confirmed order has it.
  const { data: blockers, error: blockersError } = sale.status === "confirmed" ? await supabase.rpc("customer_order_shipping_blockers", { p_sale_id: id }) : { data: [], error: null };
  const { data: dateChanges } = await supabase.from("sale_shipment_date_changes").select("id,previous_date,new_date,reason,changed_at,change_kind,changed_by,actor:profiles(full_name)").eq("sale_id", id).order("changed_at", { ascending: false });
  const canReschedule = !sale.historical_shipment_date && ["draft", "reserved", "confirmed"].includes(sale.status) && ["sales.view", "sales.manage"].every(code => (fulfillmentPermissions ?? []).includes(code));
  const businessToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Almaty" }).format(new Date());

  const [{ data: items }, { data: products }, { data: balances }, { data: letters }, { data: preparationReturns }, { data: priceChanges }] = await Promise.all([
    supabase.from("sale_items").select("*,price_author:profiles!sale_items_price_set_by_fkey(full_name),product:products(internal_sku,name,brand,packaging:product_packaging(uom,units_per_parent)),reservations:inventory_reservations(id,batch_id,quantity,uom,sale_quantity,remaining_shelf_life_pct,is_fefo_override,override_reason,status,batch:inventory_batches(batch_number,expiry_date))").eq("sale_id", id).order("created_at"),
    selectAll((from,to)=>supabase.from("products").select("id,internal_sku,name,brand,base_uom").eq("status", "active").order("internal_sku").order("id").range(from,to)),
    supabase.from("inventory_fifo_status").select("balance_id,product_id,batch_number,expiry_date,quantity_available,uom,shelf_life_percent,batch_status").eq("warehouse_id", sale.warehouse_id).gt("quantity_available", 0).order("expiry_date"),
    supabase.from("guarantee_letters").select("*,items:guarantee_letter_items(id,quantity,remaining_shelf_life_pct,required_shelf_life_pct,batch:inventory_batches(batch_number),sale_item:sale_items(product:products(internal_sku,name)))").eq("sale_id", id).order("created_at", { ascending: false }),
    supabase.from("sale_preparation_returns").select("id,reason,created_at,previous_confirmed_at").eq("sale_id", id).order("created_at", { ascending: false }),
    supabase.from("sale_item_price_changes").select("id,kind,previous_price,new_price,reason,changed_at,sale_item_id,actor:profiles(full_name)").eq("sale_id", id).order("changed_at"),
  ]);

  const customer = one(sale.customer);
  const warehouse = one(sale.warehouse);
  const currency = one(sale.currency);
  const activeLetters = (letters ?? []).filter(letter => !["cancelled", "rejected"].includes(letter.status));
  const canReturnToPreparation = canMutate && ["sales.view", "sales.manage", "sales.reserve"].every(code => (fulfillmentPermissions ?? []).includes(code)) && (!activeLetters.length || (fulfillmentPermissions ?? []).includes("guarantee_letters.manage"));
  const editable = canMutate && ["draft", "reserved"].includes(sale.status);
  const canEditPrice = editable && (fulfillmentPermissions ?? []).includes("sales.manage");
  const activeReservations = (items ?? []).flatMap((item) =>
    (item.reservations ?? [])
      .filter((reservation: { status: string }) => ["active", "fulfilled"].includes(reservation.status))
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
    ...(receiptHistory.data ?? []).map(event => ({ at: event.created_at as string, title: "Фактическая приёмка без письма и предварительного согласования", detail: `${event.reason}. Внёс: ${event.created_by}. Требование ОСГ сохранено.` })),
    ...(replacements ?? []).map(event => {
      type Row = { item_id: string; batch_number: string; quantity: number; uom: string };
      const next = event.new_allocation as Row[];
      const old = (event.previous_allocation as Row[]).filter(row => next.some(n => n.item_id === row.item_id));
      const describe = (rows: Row[]) => rows.map(r => `${r.batch_number}: ${r.quantity} ${replacementUnits[r.uom] ?? r.uom}`).join("; ");
      return { at: event.created_at as string, title: "Заменены зарезервированные партии", detail: `${event.reason}. Было: ${describe(old)}. Стало: ${describe(next)}. Сотрудник: ${one(event.actor)?.full_name ?? event.created_by}` };
    }),
    // A manual price set when the line was added; later changes come from sale_item_price_changes.
    ...(items ?? []).filter(item => item.price_source === "manual" && !(priceChanges ?? []).some(change => change.sale_item_id === item.id)).map(item => ({ at: item.created_at as string, title: `Цена указана вручную: ${one(item.product)?.internal_sku ?? ""} — ${Number(item.unit_price).toLocaleString("ru-RU")} ${currency?.code ?? ""}`, detail: `${item.price_reason}. Прайс: ${describePriceList((item.price_snapshot as PriceSnapshot | null)?.price_list_quote) || "—"}. Сотрудник: ${one(item.price_author)?.full_name ?? item.price_set_by}` })),
    ...(priceChanges ?? []).map(event => {
      const product = one((items ?? []).find(item => item.id === event.sale_item_id)?.product);
      const was = event.previous_price == null ? "без цены" : `${Number(event.previous_price).toLocaleString("ru-RU")} ${currency?.code ?? ""}`;
      return { at: event.changed_at as string, title: `${event.kind === "manual" ? "Цена указана вручную" : "Цена пересчитана из прайса"}: ${product?.internal_sku ?? ""} — ${Number(event.new_price).toLocaleString("ru-RU")} ${currency?.code ?? ""}`, detail: `Было: ${was}.${event.reason ? ` Причина: ${event.reason}.` : ""} Сотрудник: ${one(event.actor)?.full_name ?? "—"}` };
    }),
    ...(preparationReturns ?? []).map(event => ({ at: event.created_at as string, title: "Заказ возвращён к подготовке", detail: event.reason as string })),
    ...(dateChanges ?? []).map(event => ({ at: event.changed_at as string, title: `${event.change_kind === "admin_correction" ? "Дата исправлена администратором" : "Отгрузка перенесена"}: ${formatDate(event.previous_date)} → ${formatDate(event.new_date)}`, detail: `${event.reason}. Сотрудник: ${one(event.actor)?.full_name ?? event.changed_by ?? "—"}` })),
    { at: sale.created_at as string, title: sale.historical_shipment_date ? "Внесена историческая продажа" : "Заказ создан", detail: sale.historical_shipment_date ? `${sale.sale_number} · отгрузка ${formatDate(sale.historical_shipment_date)} · ${sale.historical_reference} · ${sale.historical_reason}` : sale.sale_number as string },
    ...(sale.confirmed_at ? [{ at: sale.confirmed_at as string, title: "Заказ подтверждён", detail: "Резервы проверены" }] : []),
    ...(sale.shipped_at ? [{ at: (sale.shipped_recorded_at ?? sale.shipped_at) as string, title: sale.historical_shipment_date ? "Проведена историческая продажа" : "Заказ отгружен", detail: sale.historical_shipment_date ? `Фактическая дата: ${formatDate(sale.historical_shipment_date)}. Зарезервированные партии списаны; время записи сохранено отдельно.` : "Зарезервированные партии списаны, движения записаны" }] : []),
    ...(sale.cancelled_at ? [{ at: sale.cancelled_at as string, title: "Заказ отменён", detail: sale.cancellation_reason || "Причина не указана" }] : []),
    ...(letters ?? []).flatMap((letter) => [
      { at: letter.created_at as string, title: `Создано гарантийное письмо ${letter.letter_number}`, detail: guaranteeStatuses[letter.status] ?? letter.status },
      ...(letter.approved_at ? [{ at: letter.approved_at as string, title: `Гарантийное письмо ${letter.letter_number} утверждено`, detail: "Документ готов к отправке" }] : []),
      ...(letter.sent_at ? [{ at: letter.sent_at as string, title: `Гарантийное письмо ${letter.letter_number} отправлено`, detail: "Передано клиенту" }] : []),
    ]),
  ].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());

  // Use the same employee-visible files for the tab count and its contents on every tab.
  const customerDocuments = await linkedDocuments(supabase, "customer", [sale.customer_id]);
  const documentCount = (letters?.length ?? 0) + (customerDocuments.get(sale.customer_id)?.length ?? 0);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="sales"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Заказ покупателя</p><h1>{sale.sale_number}</h1></div><div className="topbar-actions"><span className={`status sale-${sale.status}`}>{statuses[sale.status] ?? sale.status}</span><Link className="ghost button-link" href="/sales">К реестру</Link></div></header>
    <WorkflowHelp section="sales"/>
    {notices.error && <div className="login-error admin-message">{notices.error}</div>}
    {notices.success && <div className="login-success admin-message">{notices.success}</div>}
    {sale.historical_shipment_date && <section className="panel admin-section"><p className="eyebrow">Историческая продажа · только администратор</p><h2>Отгрузка {formatDate(sale.historical_shipment_date)}</h2><p>{sale.historical_reference}</p><p>Причина: {sale.historical_reason}</p><p className="form-help">Внесено: {formatDateTime(sale.created_at)}. {sale.shipped_recorded_at && `Проведено в Nexus: ${formatDateTime(sale.shipped_recorded_at)}.`} ОСГ проверяется на фактическую дату отгрузки; действуют проверки остатков, блокировки партий и гарантийных писем. Изменить дату и основание нельзя — ошибочный черновик следует отменить и создать заново.</p></section>}
    <OperationTabs ariaLabel="Разделы заказа покупателя" activeTab={notices.tab} defaultTab="main" tabs={[
      { id: "main", label: "Основное" },
      { id: "items", label: "Товары", badge: items?.length ?? 0 },
      { id: "shipping", label: "Отгрузка", badge: activeReservations.length },
      { id: "documents", label: "Документы", badge: documentCount },
      { id: "payment", label: "Оплата" },
      { id: "stages", label: "Этапы", badge: `${stageSteps.filter((step) => step.complete).length}/${stageSteps.length}` },
      { id: "history", label: "История", badge: history.length },
      { id: "returns", label: "Возвраты" },
    ]}>
      <>
        <section className="shipment-summary-grid">
          <article className="summary-card"><p>Клиент</p><strong>{customer?.short_name || customer?.legal_name}</strong><small>ОСГ по справочнику: {customer?.min_remaining_shelf_life_pct == null ? "не задано" : `${customer.min_remaining_shelf_life_pct}%`}</small></article>
          <article className="summary-card"><p>План отгрузки</p><strong>{formatDate(sale.planned_shipment_date)}</strong><small>{warehouse?.code} · {localName(warehouse?.name)}</small></article>
          <article className="summary-card"><p>Сумма заказа</p><strong>{orderTotal.toLocaleString("ru-RU")} {currency?.code ?? ""}</strong><small>Цена указана для {pricedItems} из {items?.length ?? 0} позиций</small></article>
          <article className="summary-card"><p>Контроль ОСГ</p><strong>{lowShelf ? "Нужно письмо" : "В норме"}</strong><small>По активным резервам</small></article>
        </section>
        <section className="panel admin-section"><p className="eyebrow">Реквизиты</p><h2>Условия заказа</h2><div className="operation-facts"><div><small>Дата заказа</small><strong>{formatDate(sale.sale_date)}</strong></div><div><small>Валюта</small><strong>{currency?.code ?? "—"}</strong></div><div><small>Склад отгрузки</small><strong>{warehouse?.code} · {localName(warehouse?.name)}</strong></div><div><small>Примечание</small><strong>{sale.notes || "—"}</strong></div></div></section>
        <SaleCreditWarning saleId={id} saleStatus={sale.status}/>
        {canMutate && sale.status !== "cancelled" && sale.status !== "shipped" && <section className="panel admin-section"><p className="eyebrow">Управление</p><h2>Решение по заказу</h2><div className="order-decision-actions">{sale.status === "reserved" && <form action={confirmCustomerOrder}><input type="hidden" name="sale_id" value={id}/><PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Подтвердить заказ</PendingSubmitButton></form>}<form action={cancelCustomerOrder} className="inline-action"><input type="hidden" name="sale_id" value={id}/><input name="reason" required placeholder="Причина отмены"/><PendingSubmitButton pendingText="Выполняем…" className="danger-button" type="submit">Отменить заказ</PendingSubmitButton></form></div></section>}
      </>
      <>
        {editable && <section className="panel admin-section"><p className="eyebrow">Состав заказа</p><h2>Добавить товар</h2><form action={addCustomerOrderItem} className="reference-form"><input type="hidden" name="sale_id" value={id}/><label>Товар<select name="product_id" required defaultValue=""><option value="" disabled>Выберите товар</option>{products?.map((product) => <option key={product.id} value={product.id}>{product.internal_sku} · {localName(product.name)}{product.brand ? ` · ${product.brand}` : ""}</option>)}</select></label><label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Единица<select name="uom" defaultValue="piece">{Object.entries(units).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>Цена вручную<input name="unit_price" type="number" min="0" step="0.0001" placeholder="Пусто — из прайса"/></label><label>Причина ручной цены<input name="price_reason" maxLength={1000} placeholder="Только если цена указана вручную"/></label><label>Мин. ОСГ, %<input name="required_shelf_life_pct" type="number" min="0" max="100" step="0.01" placeholder="Из карточки клиента"/></label><PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Добавить</PendingSubmitButton></form><p className="form-help">Цена подставляется из прайса клиента на дату заказа в валюте заказа. Если цены нет, позиция добавится без цены с причиной. Ручная цена сохраняется только с причиной и попадает в историю заказа.</p></section>}
        <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Заказ покупателя</p><h2>Товары</h2></div><span className="page-count">{items?.length ?? 0}</span></div>{pricedItems < (items ?? []).length && <p className="login-error admin-message">Позиций без цены: {(items ?? []).length - pricedItems}. Подтвердить заказ нельзя, пока у каждой позиции нет цены: «Пересчитать из прайса» или «Указать вручную» в строке.</p>}<div className="reference-list">{(items ?? []).map((item) => {const product = one(item.product);const lineTotal = Number(item.quantity) * Number(item.unit_price ?? 0);return <article className="reference-row" key={item.id}><div><strong>{product?.internal_sku} · {localName(product?.name)}</strong><small>{product?.brand || "Без бренда"} · требование ОСГ {item.required_shelf_life_pct ?? "—"}%</small></div><div><strong>{Number(item.quantity).toLocaleString("ru-RU")} {units[item.uom] ?? item.uom}</strong><small>{item.unit_price == null ? "Цена не указана" : `${Number(item.unit_price).toLocaleString("ru-RU")} × ${Number(item.quantity).toLocaleString("ru-RU")} = ${lineTotal.toLocaleString("ru-RU")} ${currency?.code ?? ""}`}</small><OrderLinePrice line={item}/>{canEditPrice && <OrderLinePriceActions saleId={id} itemId={item.id} priceSource={item.price_source}/>}</div></article>;})}{!items?.length && <p className="empty-state">Добавьте товары в заказ.</p>}</div></section>
      </>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Склад и FEFO</p><h2>Подготовка к отгрузке</h2></div><span className="page-count">{reservedItemCount} из {items?.length ?? 0} позиций</span></div><p className="form-help">Система резервирует партии с ближайшим сроком годности. Остаток, учтённый в других единицах, пересчитывается через упаковку товара (сколько штук в коробе, паллете); из упаковки берётся только количество, которое пересчитывается без остатка. Ручной выбор другой партии требует указать причину.</p>
        {sale.status === "confirmed" && <div className="order-blockers"><p className="eyebrow">Что мешает отгрузке</p>{blockersError ? <p className="form-help">Не удалось проверить заказ перед отгрузкой.</p> : (blockers ?? []).length ? <ul>{(blockers as { code: string; message: string }[]).map((blocker, index) => <li key={`${blocker.code}-${index}`}>{blocker.message}</li>)}</ul> : <p className="form-help">Препятствий нет: заказ можно отгружать.</p>}</div>}
        {sale.historical_shipment_date && <HistoricalActualReceipt saleId={id} status={sale.status} canRecord={canBackdate === true} preview={receiptPreview.data as ReceiptPreview | null} error={Boolean(receiptPreview.error || receiptHistory.error)} receipts={(receiptHistory.data ?? []) as ActualReceipt[]}/>}
        {canReschedule && <details className="order-reschedule"><summary>Перенести отгрузку · сейчас {formatDate(sale.planned_shipment_date)}</summary><form action={rescheduleCustomerOrder} className="inline-action"><input type="hidden" name="sale_id" value={id}/><label>Новая дата<input name="planned_shipment_date" type="date" required min={businessToday}/></label><label>Причина<input name="reason" required placeholder="Почему переносится отгрузка"/></label><PendingSubmitButton pendingText="Выполняем…" className="secondary" type="submit">Перенести</PendingSubmitButton></form>{sale.status === "confirmed" && <p className="form-help">Подтверждённый заказ переносится, только если на новую дату партии ещё годны и хватает остаточного срока или действующего гарантийного письма. Иначе верните заказ к подготовке.</p>}</details>}
        {sale.status === "confirmed" && canReturnToPreparation && <form action={returnCustomerOrderToPreparation} className="inline-action"><input type="hidden" name="sale_id" value={id}/><p className="form-help">Если партия заблокирована, просрочена или ОСГ снизился, верните заказ к подготовке. Номер, товары и резервы сохранятся. Действующие гарантийные письма будут отменены с сохранением истории; после проверки потребуется новое подтверждение заказа.</p><input name="reason" required maxLength={500} aria-label="Причина возврата к подготовке" placeholder="Причина возврата к подготовке"/><PendingSubmitButton pendingText="Выполняем…" className="secondary" type="submit">Вернуть к подготовке</PendingSubmitButton></form>}
        {sale.status === "confirmed" && canReplace && <ReservationReplacement saleId={id}/>}
        {sale.status === "confirmed" && canFulfill && <form action={fulfillCustomerOrder}><input type="hidden" name="sale_id" value={id}/><p className="form-help">Будут списаны все зарезервированные партии заказа. Требуются права управления продажами и складского движения.</p><PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Отгрузить заказ полностью</PendingSubmitButton></form>}
        {canCorrectDate === true && sale.status === "draft" && !sale.historical_shipment_date && !activeReservations.length && <AdminOrderDateCorrection saleId={id} currentDate={sale.planned_shipment_date} orderDate={sale.sale_date} today={businessToday} requestId={crypto.randomUUID()}/>}
        {sale.status === "shipped" && <p className="form-help">Отгрузка выполнена {sale.historical_shipment_date ? formatDate(sale.historical_shipment_date) : formatDateTime(sale.shipped_at)}. <Link href="/inventory/movements">Журнал складских движений</Link></p>}
        {sale.status === "shipped" && (items ?? []).flatMap(item => (item.reservations ?? [])
          .filter((r: { status: string }) => r.status === "fulfilled")
          .map((r: { id: string; quantity: number; uom: string; batch: { batch_number: string } | { batch_number: string }[] }) =>
            <p key={r.id}>Отгружена партия {one(r.batch)?.batch_number}: {Number(r.quantity).toLocaleString("ru-RU")} {units[r.uom] ?? r.uom}</p>))}
        <div className="reference-list">
        {(items ?? []).map((item) => {const product = one(item.product);const reservations = (item.reservations ?? []).filter((reservation: { status: string }) => reservation.status === "active");const packaging: { uom: string; units_per_parent: number | string }[] = product?.packaging ?? [];const itemUnit = units[item.uom] ?? item.uom;const available = (balances ?? []).filter((balance) => balance.product_id === item.product_id && (balance.uom === item.uom || convertQuantity(Number(item.quantity), item.uom, balance.uom, packaging) !== null));const itemReserved = reservations.reduce((sum: number, reservation: { quantity: number; sale_quantity: number | null }) => sum + Number(reservation.sale_quantity ?? reservation.quantity), 0);const missingPackaging = item.uom !== "piece" && piecesPerUnit(item.uom, packaging) === null;return <article className="reference-row order-item" key={item.id}><div><strong>{product?.internal_sku} · {localName(product?.name)}</strong><small>Заказано {Number(item.quantity).toLocaleString("ru-RU")} {itemUnit} · зарезервировано {itemReserved.toLocaleString("ru-RU")} {itemUnit}</small>{missingPackaging && <small className="danger-text">В карточке товара не задано, сколько штук в единице «{itemUnit}»: остаток в других единицах не будет найден.</small>}{reservations.map((reservation: { id: string; quantity: number; uom: string | null; sale_quantity: number | null; remaining_shelf_life_pct: number; is_fefo_override: boolean; override_reason: string | null; batch: unknown }) => {const batch = one(reservation.batch as { batch_number: string; expiry_date: string } | { batch_number: string; expiry_date: string }[]);const low = item.required_shelf_life_pct != null && Number(reservation.remaining_shelf_life_pct) < Number(item.required_shelf_life_pct);return <small key={reservation.id} className={low ? "danger-text" : ""}>Партия {batch?.batch_number}: {reservation.uom && reservation.uom !== item.uom ? `${Number(reservation.quantity).toLocaleString("ru-RU")} ${units[reservation.uom] ?? reservation.uom} = ${Number(reservation.sale_quantity).toLocaleString("ru-RU")} ${itemUnit}` : `${Number(reservation.sale_quantity ?? reservation.quantity).toLocaleString("ru-RU")} ${itemUnit}`} · ОСГ {reservation.remaining_shelf_life_pct}%{reservation.is_fefo_override ? ` · отклонение: ${reservation.override_reason}` : ""}</small>;})}</div>{editable && <div className="order-actions"><form action={reserveOrderItemFefo}><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="sale_item_id" value={item.id}/><PendingSubmitButton pendingText="Выполняем…" className="secondary compact" type="submit">Резервировать по FEFO</PendingSubmitButton></form>{available.length > 0 && <form action={reserveOrderItemOverride} className="inline-action"><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="sale_item_id" value={item.id}/><select name="inventory_balance_id" required defaultValue=""><option value="" disabled>Другая партия</option>{available.map((balance) => {const inOrderUnits = balance.uom === item.uom ? null : convertQuantity(Number(balance.quantity_available), balance.uom, item.uom, packaging);return <option key={balance.balance_id} value={balance.balance_id}>{balance.batch_number} · {Number(balance.quantity_available).toLocaleString("ru-RU")} {units[balance.uom] ?? balance.uom}{balance.uom === item.uom ? "" : inOrderUnits === null ? ` (не целое число: ${itemUnit})` : ` (= ${inOrderUnits.toLocaleString("ru-RU")} ${itemUnit})`} · до {balance.expiry_date}</option>;})}</select><input name="reason" required placeholder="Причина отклонения"/><PendingSubmitButton pendingText="Выполняем…" className="secondary compact" type="submit">Выбрать</PendingSubmitButton></form>}</div>}</article>;})}
        {!items?.length && <p className="empty-state">Сначала добавьте товары во вкладке «Товары».</p>}
      </div></section>
      <>
        <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Документы заказа</p><h2>Гарантийные письма</h2></div><span className="page-count">{letters?.length ?? 0}</span></div>{!activeLetters.length && editable && <form action={createGuaranteeLetter} className="inline-action"><input type="hidden" name="sale_id" value={id}/><input name="notes" placeholder="Комментарий к письму"/><PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Проверить ОСГ и подготовить письмо</PendingSubmitButton></form>}{!lowShelf && !activeLetters.length && <p className="empty-state">По последней проверке ОСГ соответствует требованиям клиента. После задержки проверьте его заново перед подтверждением заказа.</p>}{letters?.map((letter) => <article className="reference-row" key={letter.id}><div><strong>{letter.letter_number}</strong><small>{guaranteeStatuses[letter.status] ?? letter.status} · позиций: {letter.items?.length ?? 0}</small></div>{letter.status === "draft" && <div className="inline-action"><form action={createGuaranteeLetter}><input type="hidden" name="sale_id" value={id}/><PendingSubmitButton pendingText="Выполняем…" className="secondary compact">Обновить состав</PendingSubmitButton></form><form action={changeGuaranteeStatus}><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="letter_id" value={letter.id}/><input type="hidden" name="status" value="approved"/><PendingSubmitButton pendingText="Выполняем…" className="secondary compact">Утвердить</PendingSubmitButton></form></div>}{letter.status === "approved" && <form action={changeGuaranteeStatus}><input type="hidden" name="sale_id" value={id}/><input type="hidden" name="letter_id" value={letter.id}/><input type="hidden" name="status" value="sent"/><PendingSubmitButton pendingText="Выполняем…" className="secondary compact">Отметить отправленным</PendingSubmitButton></form>}</article>)}</section>
        <section className="panel admin-section"><p className="eyebrow">Архив клиента</p><h2>Счета, договоры и отгрузочные документы</h2><p className="form-help">Документы клиента хранятся в едином журнале и доступны по правам сотрудника.</p><LinkedDocuments entries={customerDocuments.get(sale.customer_id)}/><Link className="primary button-link" href={`/documents?object=customer:${sale.customer_id}&link=customer:${sale.customer_id}`}>Открыть документы клиента</Link></section>
      </>
      <SaleCreditPanel saleId={id} saleStatus={sale.status} currency={currency?.code ?? ""} orderTotal={orderTotal}/>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Процесс продажи</p><h2>Этапы заказа</h2></div><span className="page-count">{stageSteps.filter((step) => step.complete).length} из {stageSteps.length}</span></div>{sale.status === "cancelled" && <div className="login-error admin-message">Заказ отменён: {sale.cancellation_reason || "причина не указана"}</div>}<div className="order-stage-list">{stageSteps.map((step, index) => <article className={`order-stage ${step.complete ? "complete" : ""} ${step.current ? "current" : ""}`} key={step.label}><span>{step.complete ? "✓" : index + 1}</span><div><strong>{step.label}</strong><small>{step.complete ? "Выполнено" : step.current ? "Текущий этап" : "Ожидает"}</small></div></article>)}</div></section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Хронология</p><h2>История заказа</h2></div><span className="page-count">{history.length}</span></div><div className="operation-history-list">{history.map((event, index) => <article className="operation-history-row" key={`${event.at}-${index}`}><time>{formatDateTime(event.at)}</time><div><strong>{event.title}</strong><small>{event.detail}</small></div></article>)}</div></section>
      <CustomerReturnsPanel saleId={id} saleStatus={sale.status} warehouseId={sale.warehouse_id}/>
    </OperationTabs>
  </section></main>;
}
