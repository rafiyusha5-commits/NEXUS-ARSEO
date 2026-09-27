import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { issueFifo, receiveBatch } from "./actions";

const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
const shelfStates:Record<string,string>={normal:"Норма",warning:"Менее 90 дней",critical:"Менее 30 дней",expired:"Просрочено",quarantine:"Карантин",blocked:"Заблокировано"};
function name(value:unknown){if(!value||typeof value!=="object")return "—";const v=value as Record<string,unknown>;return String(v.ru??v.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
function formatDate(value:string|null){return value?new Intl.DateTimeFormat("ru-RU").format(new Date(value)):"—";}

export default async function InventoryPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const {profile,roles,supabase}=await requireUser();const notices=await searchParams;
  const [{data:stock,error},{data:shipmentItems},{data:warehouses},{data:locations},{data:products}]=await Promise.all([
    supabase.from("inventory_fifo_status").select("*").order("warehouse_code").order("internal_sku").order("fifo_rank"),
    supabase.from("shipment_items").select("id,uom,ordered_quantity,product:products(internal_sku,name),shipment:shipments(shipment_number,destination_warehouse_id,status)").order("created_at",{ascending:false}),
    supabase.from("warehouses").select("id,code,name,is_virtual,status").eq("status","active").eq("is_virtual",false).order("code"),
    supabase.from("warehouse_locations").select("id,warehouse_id,code,zone,status").eq("status","active").order("code"),
    supabase.from("products").select("id,internal_sku,name").eq("status","active").order("internal_sku"),
  ]);
  const total=(stock??[]).reduce((sum,row)=>sum+Number(row.quantity_on_hand??0),0);
  const expiring=(stock??[]).filter(row=>["warning","critical","expired"].includes(row.shelf_life_state)).length;
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="inventory"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Фаза 2 · Складской учёт</p><h1>Партии и остатки</h1></div><span className="page-count">FIFO включён</span></header>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    {error&&<div className="setup-notice">Примените миграцию <strong>202609271200_inventory_fifo.sql</strong> в Supabase. После этого появятся регистрация партий и FIFO.</div>}
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
        <button className="primary" type="submit" disabled={Boolean(error)}>Принять партию</button>
      </form></section>
      <section className="panel admin-section"><p className="eyebrow">Расход</p><h2>Списать по FIFO</h2><form action={issueFifo} className="inventory-form issue-form">
        <label>Товар<select name="product_id" required defaultValue=""><option value="" disabled>Выберите товар</option>{products?.map(p=><option value={p.id} key={p.id}>{p.internal_sku} · {name(p.name)}</option>)}</select></label>
        <label>Склад<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(w=><option value={w.id} key={w.id}>{w.code} · {name(w.name)}</option>)}</select></label>
        <label>Единица<select name="uom" defaultValue="piece"><option value="piece">Штуки</option><option value="box">Коробки</option><option value="layer">Слои паллет</option><option value="pallet">Паллеты</option><option value="truck">Фуры</option></select></label>
        <label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Основание<input name="reason" required placeholder="Продажа клиенту"/></label><label>Документ/заказ<input name="reference" placeholder="№ накладной или заказа"/></label>
        <button className="primary" type="submit" disabled={Boolean(error)}>Списать по FIFO</button>
      </form><p className="form-help">Система сама распределит количество по непросроченным партиям, начиная с ближайшего срока годности. При нехватке остатка операция отменится целиком.</p></section>
    </section>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Контроль ОСГ</p><h2>Остатки по партиям</h2></div><span className="page-count">{stock?.length??0} строк</span></div>
      <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>FIFO</th><th>Товар</th><th>Партия</th><th>Склад / зона</th><th>Остаток</th><th>Срок годности</th><th>ОСГ</th><th>Состояние</th></tr></thead><tbody>
        {stock?.map(row=><tr key={row.balance_id} className={`shelf-${row.shelf_life_state}`}><td><span className="fifo-rank">{row.fifo_rank}</span></td><td><strong>{row.internal_sku}</strong><small>{name(row.product_name)}</small></td><td><strong>{row.batch_number}</strong><small>Получено {formatDate(row.received_at)}</small></td><td><strong>{row.warehouse_code}</strong><small>{row.location_code||"Без зоны"}</small></td><td><strong>{Number(row.quantity_available).toLocaleString("ru-RU")} {units[row.uom]??row.uom}</strong><small>Всего: {Number(row.quantity_on_hand).toLocaleString("ru-RU")}</small></td><td><strong>{formatDate(row.expiry_date)}</strong><small>{row.days_remaining} дней</small></td><td><strong>{row.shelf_life_percent===null?"—":`${row.shelf_life_percent}%`}</strong></td><td><span className="status">{shelfStates[row.shelf_life_state]??row.shelf_life_state}</span></td></tr>)}
        {!stock?.length&&!error&&<tr><td colSpan={8}><div className="empty-state">Остатков пока нет. Зарегистрируйте первую принятую партию.</div></td></tr>}
      </tbody></table></div>
    </section>
  </section></main>;
}
