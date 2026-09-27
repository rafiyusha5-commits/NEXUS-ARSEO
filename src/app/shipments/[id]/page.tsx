import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { addShipmentItem, addShipmentTransport, changeStageStatus } from "../actions";

const shipmentStatus:Record<string,string>={planning:"Планирование",in_production:"У производителя",preparing_transport:"Подготовка перевозки",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Реализация",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
const stageStatus:Record<string,string>={pending:"Ожидает",in_progress:"В работе",blocked:"Заблокирован",completed:"Завершён",skipped:"Пропущен",not_applicable:"Не требуется"};
const transportStatus:Record<string,string>={planned:"Запланирован",loading:"На загрузке",in_transit:"В пути",customs:"На таможне",arrived:"Прибыл",cancelled:"Отменён"};
const unitName:Record<string,string>={piece:"шт.",box:"кор.",pallet:"пал."};
function name(value:unknown){if(!value||typeof value!=="object")return "—";const v=value as Record<string,unknown>;return String(v.ru??v.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}

export default async function ShipmentPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{error?:string;success?:string}>}){
  const {id}=await params; const notices=await searchParams; const {profile,roles,supabase}=await requireUser();
  const [{data:shipment,error},{data:runs},{data:products},{data:items},{data:transports}]=await Promise.all([
    supabase.from("shipments").select("id,shipment_number,project_code,type,status,planned_ready_date,planned_arrival_date,created_at,supplier:counterparties!shipments_supplier_id_fkey(legal_name,short_name),customer:counterparties!shipments_customer_id_fkey(legal_name,short_name),route:routes(name),warehouse:warehouses(name),currency:currencies(id,code),responsible:profiles!shipments_responsible_user_id_fkey(full_name)").eq("id",id).maybeSingle(),
    supabase.from("shipment_stage_runs").select("id,status,is_required,status_reason,started_at,completed_at,performed_by_name,stage:shipment_stages(code,name,sequence_order,requirement,status_category,scope)").eq("shipment_id",id).order("stage(sequence_order)"),
    supabase.from("products").select("id,internal_sku,name,brand").eq("status","active").order("internal_sku"),
    supabase.from("shipment_items").select("id,uom,ordered_quantity,confirmed_quantity,unit_price,product:products(internal_sku,name,brand),transport:shipment_transports(sequence_no)").eq("shipment_id",id).order("created_at"),
    supabase.from("shipment_transports").select("id,sequence_no,status,planned_loading_date,planned_arrival_date,temperature_setpoint,notes").eq("shipment_id",id).order("sequence_no"),
  ]);
  if(error||!shipment)notFound();
  const supplier=one(shipment.supplier); const customer=one(shipment.customer); const route=one(shipment.route);
  const warehouse=one(shipment.warehouse); const currency=one(shipment.currency); const responsible=one(shipment.responsible);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Поставка · {shipment.type}</p><h1>{shipment.shipment_number}</h1></div><div className="topbar-actions"><span className={`status shipment-${shipment.status}`}>{shipmentStatus[shipment.status]??shipment.status}</span><Link className="ghost button-link" href="/shipments">К реестру</Link></div></header>
    {notices.error&&<div className="login-error admin-message">{notices.error}</div>}{notices.success&&<div className="login-success admin-message">{notices.success}</div>}
    <section className="shipment-summary-grid">
      <article className="summary-card"><p>Проект</p><strong>{shipment.project_code||"—"}</strong><small>{supplier?.short_name||supplier?.legal_name||customer?.short_name||customer?.legal_name||"Контрагент не указан"}</small></article>
      <article className="summary-card"><p>Маршрут</p><strong>{name(route?.name)}</strong><small>Склад: {name(warehouse?.name)}</small></article>
      <article className="summary-card"><p>Ответственный</p><strong>{responsible?.full_name||"—"}</strong><small>Валюта: {currency?.code||"—"}</small></article>
      <article className="summary-card"><p>Плановое прибытие</p><strong>{shipment.planned_arrival_date?new Intl.DateTimeFormat("ru-RU").format(new Date(shipment.planned_arrival_date)):"—"}</strong><small>Готовность: {shipment.planned_ready_date?new Intl.DateTimeFormat("ru-RU").format(new Date(shipment.planned_ready_date)):"—"}</small></article>
    </section>
    <section className="shipment-detail-grid">
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Заказ поставщику</p><h2>Позиции</h2></div><span className="page-count">{items?.length??0}</span></div>
        <form action={addShipmentItem} className="shipment-subform"><input type="hidden" name="shipment_id" value={shipment.id}/><input type="hidden" name="currency_id" value={currency?.id??""}/>
          <label>Товар<select name="product_id" required defaultValue=""><option value="" disabled>Выберите товар</option>{products?.map((product)=><option value={product.id} key={product.id}>{product.internal_sku} · {name(product.name)}</option>)}</select></label>
          <label>Количество<input name="ordered_quantity" type="number" min="0.001" step="0.001" required/></label><label>Ед. изм.<select name="uom" defaultValue="piece"><option value="piece">Штуки</option><option value="box">Коробки</option><option value="pallet">Паллеты</option></select></label><label>Цена за единицу<input name="unit_price" type="number" min="0" step="0.0001"/></label><button className="primary" type="submit">Добавить</button>
        </form>
        <div className="compact-list">{items?.map((item)=>{const product=one(item.product);const transport=one(item.transport);return <div className="compact-row" key={item.id}><div><strong>{name(product?.name)}</strong><small>{product?.internal_sku} · {product?.brand||"Без бренда"}</small></div><div><strong>{Number(item.ordered_quantity).toLocaleString("ru-RU")} {unitName[item.uom]??item.uom}</strong><small>{transport?`Автомобиль №${transport.sequence_no}`:"Не распределено"}</small></div><div><strong>{item.unit_price?`${Number(item.unit_price).toLocaleString("ru-RU")} ${currency?.code??""}`:"Цена не указана"}</strong></div></div>;})}{!items?.length&&<div className="empty-state">Позиции ещё не добавлены.</div>}</div>
      </section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Логистика</p><h2>Перевозки</h2></div><span className="page-count">{transports?.length??0}</span></div>
        <form action={addShipmentTransport} className="shipment-subform transport-subform"><input type="hidden" name="shipment_id" value={shipment.id}/><label>План загрузки<input name="planned_loading_date" type="date"/></label><label>План прибытия<input name="planned_arrival_date" type="date"/></label><label>Температура<input name="temperature_setpoint" placeholder="+15…+25 °C"/></label><label>Примечание<input name="notes" placeholder="Автомобиль или рейс"/></label><button className="primary" type="submit">Добавить автомобиль</button></form>
        <div className="compact-list">{transports?.map((transport)=><div className="compact-row" key={transport.id}><div><strong>Автомобиль №{transport.sequence_no}</strong><small>{transport.notes||"Перевозчик будет назначен позже"}</small></div><span className="status shipment-planning">{transportStatus[transport.status]??transport.status}</span><div><strong>{transport.planned_loading_date?new Intl.DateTimeFormat("ru-RU").format(new Date(transport.planned_loading_date)):"—"}</strong><small>план загрузки</small></div></div>)}{!transports?.length&&<div className="empty-state">Добавьте первый автомобиль для распределения товара.</div>}</div>
      </section>
    </section>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Процесс RVI</p><h2>Этапы поставки</h2></div><span className="page-count">{runs?.filter((run)=>run.status==="completed").length??0} из {runs?.length??0} завершено</span></div>
      <div className="stage-list">{runs?.map((run)=>{const stage=one(run.stage);return <article className={`stage-row stage-${run.status}`} key={run.id}>
        <div className="stage-number">{stage?.sequence_order}</div><div className="stage-copy"><strong>{name(stage?.name)}</strong><small>{stage?.scope==="transport"?"По перевозке":"По поставке"} · {stage?.requirement==="required"?"обязательный":stage?.requirement==="conditional"?"по условию":"необязательный"}</small>{run.status_reason&&<p>{run.status_reason}</p>}</div>
        <span className={`status stage-badge-${run.status}`}>{stageStatus[run.status]??run.status}</span>
        <form action={changeStageStatus} className="stage-action"><input type="hidden" name="run_id" value={run.id}/><input type="hidden" name="shipment_id" value={shipment.id}/><select name="status" defaultValue={run.status}><option value="pending">Ожидает</option><option value="in_progress">В работе</option><option value="completed">Завершён</option><option value="blocked">Заблокирован</option><option value="skipped">Пропущен</option><option value="not_applicable">Не требуется</option></select><input name="reason" placeholder="Причина, если требуется"/><button className="ghost compact" type="submit">Сохранить</button></form>
      </article>;})}</div>
    </section>
  </section></main>;
}
