import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";

const shipmentLabels: Record<string,string>={planning:"Планирование",in_production:"Производство",preparing_transport:"Подготовка транспорта",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Продажи",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
const saleLabels:Record<string,string>={draft:"Черновик",reserved:"Зарезервирован",confirmed:"Подтверждён",shipped:"Отгружен",cancelled:"Отменён"};
const number=(value:number)=>new Intl.NumberFormat("ru-RU").format(value);
const date=(value:string|null|undefined)=>value?new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`)):"—";
function counts(rows:{status:string}[]){return [...rows.reduce((map,row)=>map.set(row.status,(map.get(row.status)??0)+1),new Map<string,number>())].sort((a,b)=>b[1]-a[1]);}
function productName(value:unknown){if(!value||typeof value!=="object")return"Товар";const name=value as Record<string,unknown>;return String(name.ru??name.en??name.kz??"Товар");}

export default async function AnalyticsPage(){
 const{profile,roles,supabase}=await requireUser();
 const codes=["reports.view","shipments.view","sales.view","inventory.view","tasks.view","integrations.view"];
 const{data:permissions}=await supabase.rpc("my_permissions",{p_codes:codes});const access=new Set((permissions??[])as string[]);
 if(!access.has("reports.view"))return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="analytics"/><section className="workspace admin-workspace"><header className="topbar"><div><p className="eyebrow">Фаза 7 · Аналитика</p><h1>Операционные показатели</h1></div></header><div className="login-error admin-message">Нет доступа к отчётам.</div></section></main>;

 const empty=Promise.resolve({data:[],error:null});
 const [shipmentsResult,stagesResult,salesResult,inventoryResult,tasksResult,syncResult]=await Promise.all([
  access.has("shipments.view")?supabase.from("shipments").select("id,shipment_number,status,planned_arrival_date"):empty,
  access.has("shipments.view")?supabase.from("shipment_stage_runs").select("id,status,due_at,is_required"):empty,
  access.has("sales.view")?supabase.from("sales").select("id,sale_number,status,planned_shipment_date"):empty,
  access.has("inventory.view")?supabase.from("inventory_fifo_status").select("balance_id,batch_id,batch_number,expiry_date,shelf_life_state,quantity_available,uom,internal_sku,product_name,warehouse_code").order("expiry_date").limit(500):empty,
  access.has("tasks.view")?supabase.from("tasks").select("id,status,due_at"):empty,
  access.has("integrations.view")?supabase.from("synchronization_runs").select("id,status,started_at").order("started_at",{ascending:false}).limit(50):empty,
 ]);
 const shipments=shipmentsResult.data??[];const stages=stagesResult.data??[];const sales=salesResult.data??[];const inventory=inventoryResult.data??[];const tasks=tasksResult.data??[];const syncs=syncResult.data??[];
 const currentTime=new Date();const today=new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(currentTime);const now=currentTime.getTime();
 const activeShipments=shipments.filter(row=>!["closed","cancelled"].includes(row.status));
 const lateShipments=activeShipments.filter(row=>row.planned_arrival_date&&row.planned_arrival_date<today);
 const blockedStages=stages.filter(row=>row.status==="blocked");
 const lateStages=stages.filter(row=>row.is_required&&!['completed','skipped','not_applicable'].includes(row.status)&&row.due_at&&new Date(row.due_at).getTime()<now);
 const openSales=sales.filter(row=>!["shipped","cancelled"].includes(row.status));
 const lateSales=openSales.filter(row=>row.planned_shipment_date<today);
 const riskInventory=inventory.filter(row=>["critical","expired"].includes(row.shelf_life_state));
 const openTasks=tasks.filter(row=>!["done","cancelled"].includes(row.status));
 const lateTasks=openTasks.filter(row=>row.due_at&&new Date(row.due_at).getTime()<now);
 const failedSyncs=syncs.filter(row=>["failed","partial"].includes(row.status));
 const sourceErrors=[shipmentsResult,stagesResult,salesResult,inventoryResult,tasksResult,syncResult].filter(result=>result.error).length;
 const hasOperationalSource=["shipments.view","sales.view","inventory.view","tasks.view","integrations.view"].some(code=>access.has(code));
 return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="analytics"/><section className="workspace admin-workspace"><header className="topbar"><div><p className="eyebrow">Фаза 7 · Аналитика</p><h1>Операционные показатели</h1></div><span className="page-count">на {date(today)}</span></header>
 {sourceErrors>0&&<div className="setup-notice">Часть источников временно недоступна. Доступные показатели рассчитаны без них.</div>}
 {!hasOperationalSource&&<div className="setup-notice">Отчёт открыт, но исходные разделы недоступны вашей роли.</div>}
 <section className="summary-grid analytics-summary">
  {access.has("shipments.view")&&<article className="summary-card"><p>Активные поставки</p><strong>{number(activeShipments.length)}</strong><small className={lateShipments.length?"danger-text":""}>просрочено: {number(lateShipments.length)}</small></article>}
  {access.has("shipments.view")&&<article className="summary-card"><p>Этапы под контролем</p><strong>{number(blockedStages.length+lateStages.length)}</strong><small>заблокировано {number(blockedStages.length)} · просрочено {number(lateStages.length)}</small></article>}
  {access.has("sales.view")&&<article className="summary-card"><p>Открытые заказы</p><strong>{number(openSales.length)}</strong><small className={lateSales.length?"danger-text":""}>к отгрузке просрочено: {number(lateSales.length)}</small></article>}
  {access.has("inventory.view")&&<article className="summary-card"><p>Риск по ОСГ</p><strong>{number(riskInventory.length)}</strong><small>критические и просроченные партии</small></article>}
  {access.has("tasks.view")&&<article className="summary-card"><p>Открытые задачи</p><strong>{number(openTasks.length)}</strong><small className={lateTasks.length?"danger-text":""}>просрочено: {number(lateTasks.length)}</small></article>}
  {access.has("integrations.view")&&<article className="summary-card"><p>Проблемные синхронизации</p><strong>{number(failedSyncs.length)}</strong><small>среди последних {number(syncs.length)} запусков</small></article>}
 </section>
 <section className="content-grid analytics-grid">
  {access.has("shipments.view")&&<section className="panel"><div className="panel-heading"><div><p className="eyebrow">Логистика</p><h2>Поставки по статусам</h2></div><Link className="text-button" href="/shipments">Открыть поставки</Link></div><div className="analytics-bars">{counts(shipments).map(([key,value])=><div key={key}><span>{shipmentLabels[key]??key}</span><b>{number(value)}</b><i style={{width:`${Math.max(6,value/Math.max(1,shipments.length)*100)}%`}}/></div>)}{!shipments.length&&<p className="empty-state">Данных пока нет.</p>}</div></section>}
  {access.has("sales.view")&&<section className="panel"><div className="panel-heading"><div><p className="eyebrow">Продажи</p><h2>Заказы по статусам</h2></div><Link className="text-button" href="/sales">Открыть заказы</Link></div><div className="analytics-bars">{counts(sales).map(([key,value])=><div key={key}><span>{saleLabels[key]??key}</span><b>{number(value)}</b><i style={{width:`${Math.max(6,value/Math.max(1,sales.length)*100)}%`}}/></div>)}{!sales.length&&<p className="empty-state">Данных пока нет.</p>}</div></section>}
 </section>
 {access.has("inventory.view")&&<section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Остатки</p><h2>Ближайшие риски по сроку годности</h2></div><Link className="text-button" href="/inventory">Открыть FIFO</Link></div><div className="import-table-wrap"><table className="import-table"><thead><tr><th>Товар</th><th>Партия</th><th>Склад</th><th>Годен до</th><th>Доступно</th><th>Риск</th></tr></thead><tbody>{riskInventory.slice(0,12).map(row=><tr key={row.balance_id}><td><strong>{row.internal_sku}</strong><br/>{productName(row.product_name)}</td><td>{row.batch_number}</td><td>{row.warehouse_code}</td><td>{date(row.expiry_date)}</td><td>{row.quantity_available} {row.uom}</td><td><span className={`status ${row.shelf_life_state==="expired"?"danger-text":"warning"}`}>{row.shelf_life_state==="expired"?"Просрочено":"Критично"}</span></td></tr>)}</tbody></table>{!riskInventory.length&&<p className="empty-state">Критических и просроченных партий нет.</p>}</div></section>}
 </section></main>;
}
