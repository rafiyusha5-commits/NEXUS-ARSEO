import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { transferInventory, writeOffInventory } from "./actions";

const units:Record<string,string>={piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"фура"};
const movementLabels:Record<string,string>={receipt:"Приход",transfer:"Перемещение",issue:"Расход FIFO",write_off:"Списание",adjustment:"Корректировка"};
function name(value:unknown){if(!value||typeof value!=="object")return "—";const v=value as Record<string,unknown>;return String(v.ru??v.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}
function formatDate(value:string){return new Intl.DateTimeFormat("ru-RU",{dateStyle:"short",timeStyle:"short"}).format(new Date(value));}

export default async function InventoryMovementsPage({searchParams}:{searchParams:Promise<{error?:string;success?:string}>}){
  const {profile,roles,supabase}=await requireUser();const notices=await searchParams;
  const [{data:stock,error:stockError},{data:warehouses},{data:locations},{data:movements,error:movementsError}]=await Promise.all([
    supabase.from("inventory_fifo_status").select("*").gt("quantity_available",0).order("warehouse_code").order("internal_sku").order("fifo_rank"),
    supabase.from("warehouses").select("id,code,name,is_virtual,status").eq("status","active").eq("is_virtual",false).order("code"),
    supabase.from("warehouse_locations").select("id,warehouse_id,code,zone,status").eq("status","active").order("code"),
    supabase.from("inventory_movements").select("id,batch_id,movement_type,quantity,uom,from_warehouse_id,to_warehouse_id,reference,reason,performed_by_name,transfer_group_id,created_at,batch:inventory_batches(batch_number,product:products(internal_sku,name))").order("created_at",{ascending:false}).limit(100),
  ]);
  const setupError=stockError??movementsError;
  const warehouseMap=new Map((warehouses??[]).map(w=>[w.id,w.code]));
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="inventory-movements"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Фаза 2 · Складской учёт</p><h1>Движения товара</h1></div><div className="topbar-actions"><Link className="secondary compact" href="/inventory">Остатки FIFO</Link><span className="page-count">{movements?.length??0} операций</span></div></header>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    {setupError&&<div className="setup-notice">Примените миграцию <strong>202609271400_inventory_movements.sql</strong> в Supabase.</div>}
    <section className="inventory-forms">
      <section className="panel admin-section"><p className="eyebrow">Склад → склад</p><h2>Переместить партию</h2><form action={transferInventory} className="inventory-form">
        <label>Исходный остаток<select name="balance_id" required defaultValue=""><option value="" disabled>Выберите партию</option>{stock?.map(row=><option value={row.balance_id} key={row.balance_id}>{row.warehouse_code} · {row.internal_sku} · {row.batch_number} · {Number(row.quantity_available)} {units[row.uom]??row.uom}</option>)}</select></label>
        <label>Склад назначения<select name="to_warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map(w=><option value={w.id} key={w.id}>{w.code} · {name(w.name)}</option>)}</select></label>
        <label>Зона назначения<select name="to_location_id" defaultValue=""><option value="">Без зоны</option>{locations?.map(l=><option value={l.id} key={l.id}>{l.code} · {l.zone}</option>)}</select></label>
        <label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Документ<input name="reference" placeholder="№ накладной"/></label><label>Причина<input name="reason" placeholder="Пополнение склада"/></label>
        <label>Фактический исполнитель<input name="performed_by_name" placeholder="ФИО работника склада"/></label><button className="primary" type="submit" disabled={Boolean(setupError)}>Переместить</button>
      </form><p className="form-help">Система уменьшает исходный остаток, увеличивает остаток той же партии на складе назначения и создаёт две записи с общим номером перемещения.</p></section>
      <section className="panel admin-section"><p className="eyebrow">Брак и просрочка</p><h2>Списать остаток</h2><form action={writeOffInventory} className="inventory-form">
        <label>Остаток<select name="balance_id" required defaultValue=""><option value="" disabled>Выберите партию</option>{stock?.map(row=><option value={row.balance_id} key={row.balance_id}>{row.warehouse_code} · {row.internal_sku} · {row.batch_number} · {Number(row.quantity_available)} {units[row.uom]??row.uom}</option>)}</select></label>
        <label>Количество<input name="quantity" type="number" min="0.001" step="0.001" required/></label><label>Причина<input name="reason" required placeholder="Брак / истёк срок"/></label><label>Акт списания<input name="reference" placeholder="№ акта"/></label><label>Фактический исполнитель<input name="performed_by_name" placeholder="ФИО работника склада"/></label>
        <button className="primary" type="submit" disabled={Boolean(setupError)}>Списать</button>
      </form><p className="form-help">Причина обязательна. Списание нельзя изменить или удалить; оно остаётся в журнале аудита.</p></section>
    </section>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Неизменяемый журнал</p><h2>Последние движения</h2></div><span className="page-count">до 100 записей</span></div>
      <div className="inventory-table-wrap"><table className="inventory-table"><thead><tr><th>Дата</th><th>Операция</th><th>Товар / партия</th><th>Количество</th><th>Откуда → куда</th><th>Документ / причина</th><th>Исполнитель</th></tr></thead><tbody>
        {movements?.map(m=>{const batch=one(m.batch);const product=one(batch?.product);return <tr key={m.id}><td>{formatDate(m.created_at)}</td><td><span className="status">{movementLabels[m.movement_type]??m.movement_type}</span></td><td><strong>{product?.internal_sku}</strong><small>{batch?.batch_number} · {name(product?.name)}</small></td><td><strong>{Number(m.quantity).toLocaleString("ru-RU")} {units[m.uom]??m.uom}</strong>{m.transfer_group_id&&<small>Группа {String(m.transfer_group_id).slice(0,8)}</small>}</td><td><strong>{warehouseMap.get(m.from_warehouse_id)||"—"} → {warehouseMap.get(m.to_warehouse_id)||"—"}</strong></td><td><strong>{m.reference||"—"}</strong><small>{m.reason||"Без комментария"}</small></td><td>{m.performed_by_name||profile.full_name}</td></tr>;})}
        {!movements?.length&&!setupError&&<tr><td colSpan={7}><div className="empty-state">Движений пока нет.</div></td></tr>}
      </tbody></table></div>
    </section>
  </section></main>;
}
