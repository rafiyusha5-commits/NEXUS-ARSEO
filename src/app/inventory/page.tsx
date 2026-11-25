import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requirePageUser } from "@/lib/auth/access";
import { issueFifo, receiveBatch, setBatchStatus } from "./actions";
import { selectAll } from "@/lib/supabase/select-all";

const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
const shelfStates:Record<string,string>={normal:"Норма",warning:"Менее 90 дней",critical:"Менее 30 дней",expired:"Просрочено",quarantine:"Карантин",blocked:"Заблокировано"};
function name(value:unknown){if(!value||typeof value!=="object")return "—";const v=value as Record<string,unknown>;return String(v.ru??v.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
function formatDate(value:string|null){return value?new Intl.DateTimeFormat("ru-RU").format(new Date(value)):"—";}

export default async function InventoryPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const {profile,roles,supabase}=await requirePageUser();const notices=await searchParams;
  const [{data:stock,error},{data:shipmentItems},{data:warehouses},{data:locations},{data:products}]=await Promise.all([
    supabase.from("inventory_fifo_status").select("*").order("warehouse_code").order("internal_sku").order("fifo_rank"),
    supabase.from("shipment_items").select("id,uom,ordered_quantity,product:products(internal_sku,name),shipment:shipments(shipment_number,destination_warehouse_id,status)").order("created_at",{ascending:false}),
    supabase.from("warehouses").select("id,code,name,is_virtual,status").eq("status","active").eq("is_virtual",false).order("code"),
    supabase.from("warehouse_locations").select("id,warehouse_id,code,zone,status").eq("status","active").order("code"),
    selectAll((from,to)=>supabase.from("products").select("id,internal_sku,name").eq("status","active").order("internal_sku").order("id").range(from,to)),
  ]);
  const total=(stock??[]).reduce((sum,row)=>sum+Number(row.quantity_on_hand??0),0);
  const expiring=(stock??[]).filter(row=>["warning","critical","expired"].includes(row.shelf_life_state)).length;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="inventory"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Складской учёт</p><h1>Партии и остатки</h1></div><div className="topbar-actions"><Link className="secondary compact" href="/inventory/movements">Движения</Link><Link className="secondary compact" href="/inventory/shelf-life">Контроль ОСГ</Link><span className="page-count">FIFO включён</span></div></header>
    <WorkflowHelp section="inventory"/>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    {error&&<div className="setup-notice">Не удалось загрузить данные раздела. Обновите страницу. Если ошибка повторится, сообщите администратору название раздела. После этого появятся регистрация партий и FIFO.</div>}
    <section className="shipment-summary-grid inventory-summary">
      <article className="summary-card"><p>Активных строк остатков</p><strong>{stock?.length??0}</strong><small>По партиям, складам и зонам</small></article>
      <article className="summary-card"><p>Количество</p><strong>{total.toLocaleString("ru-RU")}</strong><small>В единицах учёта партий</small></article>
      <article className="summary-card"><p>Требуют внимания</p><strong>{expiring}</strong><small>Истекающие или просроченные партии</small></article>
      <article className="summary-card"><p>Принцип отбора</p><strong>FIFO</strong><small>Сначала ближайший срок годности</small></article>
    </section>
    <section className="inventory-forms">
      <section className="panel admin-section"><p className="eyebrow">Приёмка</p><h2>Зарегистрировать партию</h2><form action={receiveBatch} className="inventory-form">
        <label>Позиция поставки<select name="shipment_item_id" required defaultValue=""><option value="" disabled>Выберите позицию</option>{shipmentItems?.map(item=>{const product=one(item.product);const shipment=one(item.shipment);return <option value={item.id} key={item.id}>{shipment?.shipment_number} · {product?.internal_sku} · {name(product?.name)}</option>;})}</select></label>
        <label>Склад<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(w=><option value={w.id} key={w.id}>{w.code} · {name(w.name)}</option>)}</select></label>
        <label>Зона<select name="location_id" defaultValue=""><option value="">Без зоны</option>{locations?.map(l=><option value={l.id} key={l.id}>{l.code} · {l.zone}</option>)}</select></label>
        <label>Номер партии<input name="batch_number" required placeholder="LOT-2026-001"/></label>
        <label>Дата производства<input name="manufacture_date" type="date"/></label><label>Срок годности<input name="expiry_date" type="date" required/></label>
        <label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Примечание<input name="notes"/></label>
        <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit" disabled={Boolean(error)}>Принять партию</PendingSubmitButton>
      </form></section>
      <section className="panel admin-section"><p className="eyebrow">Расход</p><h2>Списать по FIFO</h2><form action={issueFifo} className="inventory-form issue-form">
        <label>Товар<select name="product_id" required defaultValue=""><option value="" disabled>Выберите товар</option>{products?.map(p=><option value={p.id} key={p.id}>{p.internal_sku} · {name(p.name)}</option>)}</select></label>
        <label>Склад<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(w=><option value={w.id} key={w.id}>{w.code} · {name(w.name)}</option>)}</select></label>
        <label>Единица<select name="uom" defaultValue="piece"><option value="piece">Штуки</option><option value="box">Коробки</option><option value="layer">Слои паллет</option><option value="pallet">Паллеты</option><option value="truck">Фуры</option></select></label>
        <label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Основание<input name="reason" required placeholder="Продажа клиенту"/></label><label>Документ/заказ<input name="reference" placeholder="№ накладной или заказа"/></label>
        <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit" disabled={Boolean(error)}>Списать по FIFO</PendingSubmitButton>
      </form><p className="form-help">Система сама распределит количество по непросроченным партиям, начиная с ближайшего срока годности. При нехватке остатка операция отменится целиком.</p></section>
      <section className="panel admin-section"><p className="eyebrow">Контроль качества</p><h2>Изменить состояние партии</h2><form action={setBatchStatus} className="inventory-form issue-form">
        <label>Партия<select name="batch_id" required defaultValue=""><option value="" disabled>Выберите партию</option>{stock?.map(row=><option value={row.batch_id} key={row.balance_id}>{row.internal_sku} · {row.batch_number} · {row.warehouse_code}</option>)}</select></label>
        <label>Новое состояние<select name="status" required defaultValue="blocked"><option value="blocked">Заблокировано</option><option value="quarantine">Карантин</option><option value="available">Доступно к отбору</option></select></label>
        <label>Причина<input name="reason" placeholder="Обязательна для блокировки и карантина"/></label>
        <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit" disabled={Boolean(error)||!stock?.length}>Сохранить состояние</PendingSubmitButton>
      </form><p className="form-help">Заблокированные и карантинные партии автоматически исключаются из FIFO. Разблокировка выполняется только вручную.</p></section>
    </section>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Контроль ОСГ</p><h2>Остатки по партиям</h2></div><span className="page-count">{stock?.length??0} строк</span></div>
      <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>FIFO</th><th>Товар</th><th>Партия</th><th>Склад / зона</th><th>Остаток</th><th>Срок годности</th><th>ОСГ</th><th>Состояние</th></tr></thead><tbody>
        {stock?.map(row=><tr key={row.balance_id} className={`shelf-${row.shelf_life_state}`}><td><span className="fifo-rank">{row.fifo_rank}</span></td><td><strong>{row.internal_sku}</strong><small>{name(row.product_name)}</small></td><td><Link className="inventory-batch-link" href={`/inventory/${row.batch_id}`}><strong>{row.batch_number}</strong><small>Получено {formatDate(row.received_at)} · открыть →</small></Link></td><td><Link className="inventory-batch-link" href={`/warehouses/${row.warehouse_id}`}><strong>{row.warehouse_code}</strong><small>{row.location_code||"Без зоны"}</small></Link></td><td><strong>{Number(row.quantity_available).toLocaleString("ru-RU")} {units[row.uom]??row.uom}</strong><small>Всего: {Number(row.quantity_on_hand).toLocaleString("ru-RU")}</small></td><td><strong>{formatDate(row.expiry_date)}</strong><small>{row.days_remaining} дней</small></td><td><strong>{row.shelf_life_percent===null?"—":`${row.shelf_life_percent}%`}</strong></td><td><span className="status">{shelfStates[row.shelf_life_state]??row.shelf_life_state}</span>{row.status_reason&&<small>{row.status_reason}</small>}</td></tr>)}
        {!stock?.length&&!error&&<tr><td colSpan={8}><div className="empty-state">Остатков пока нет. Зарегистрируйте первую принятую партию.</div></td></tr>}
      </tbody></table></div>
    </section>
  </section></main>;
}
