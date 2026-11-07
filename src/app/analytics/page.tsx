import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { parseOperationalSummary } from "@/lib/analytics/summary";

const shipmentLabels: Record<string,string>={planning:"Планирование",in_production:"Производство",preparing_transport:"Подготовка транспорта",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Продажи",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
const saleLabels:Record<string,string>={draft:"Черновик",reserved:"Зарезервирован",confirmed:"Подтверждён",shipped:"Отгружен",cancelled:"Отменён"};
const number=(value:number)=>new Intl.NumberFormat("ru-RU").format(value);
const date=(value:string|null|undefined)=>value?new Intl.DateTimeFormat("ru-RU").format(new Date(`${value}T00:00:00`)):"—";
function productName(value:unknown){if(!value||typeof value!=="object")return"Товар";const name=value as Record<string,unknown>;return String(name.ru??name.en??name.kz??"Товар");}

export default async function AnalyticsPage(){
 const{profile,roles,supabase}=await requireUser();
 const codes=["reports.view","shipments.view","sales.view","inventory.view","tasks.view","integrations.view"];
 const{data:permissions}=await supabase.rpc("my_permissions",{p_codes:codes});const access=new Set((permissions??[])as string[]);
 if(!access.has("reports.view"))return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="analytics"/><section className="workspace admin-workspace"><header className="topbar"><div><p className="eyebrow">Аналитика</p><h1>Операционные показатели</h1></div></header><div className="login-error admin-message">Нет доступа к отчётам.</div></section></main>;

 const empty=Promise.resolve({data:[],error:null});
 // Counts come from the database (operational_summary): a list request returns at most 1000 rows.
 const [summaryResult,inventoryResult,syncResult]=await Promise.all([
  supabase.rpc("operational_summary"),
  access.has("inventory.view")?supabase.from("inventory_fifo_status").select("balance_id,batch_id,batch_number,expiry_date,shelf_life_state,quantity_available,uom,internal_sku,product_name,warehouse_code").in("shelf_life_state",["critical","expired"]).order("expiry_date").limit(12):empty,
  access.has("integrations.view")?supabase.from("synchronization_runs").select("id,status,started_at").order("started_at",{ascending:false}).limit(50):empty,
 ]);
 const summary=parseOperationalSummary(summaryResult.error?null:summaryResult.data);const riskInventory=inventoryResult.data??[];const syncs=syncResult.data??[];
 const today=summary.today??new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Almaty"}).format(new Date());
 const failedSyncs=syncs.filter(row=>["failed","partial"].includes(row.status));
 const sourceErrors=[summaryResult,inventoryResult,syncResult].filter(result=>result.error).length;
 const hasOperationalSource=["shipments.view","sales.view","inventory.view","tasks.view","integrations.view"].some(code=>access.has(code));
 return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="analytics"/><section className="workspace admin-workspace"><header className="topbar"><div><p className="eyebrow">Аналитика</p><h1>Операционные показатели</h1></div><span className="page-count">на {date(today)}</span></header>
    <WorkflowHelp section="analytics"/>
 {sourceErrors>0&&<div className="setup-notice">Часть источников временно недоступна. Доступные показатели рассчитаны без них.</div>}
 {!hasOperationalSource&&<div className="setup-notice">Отчёт открыт, но исходные разделы недоступны вашей роли.</div>}
 <section className="summary-grid analytics-summary">
  {access.has("shipments.view")&&summary.shipments&&<article className="summary-card"><p>Активные поставки</p><strong>{number(summary.shipments.active)}</strong><small className={summary.shipments.late?"danger-text":""}>просрочено: {number(summary.shipments.late)}</small></article>}
  {access.has("shipments.view")&&summary.stages&&<article className="summary-card"><p>Этапы под контролем</p><strong>{number(summary.stages.attention)}</strong><small>заблокировано {number(summary.stages.blocked)} · просрочено {number(summary.stages.late)}</small></article>}
  {access.has("sales.view")&&summary.sales&&<article className="summary-card"><p>Открытые заказы</p><strong>{number(summary.sales.open)}</strong><small className={summary.sales.late?"danger-text":""}>к отгрузке просрочено: {number(summary.sales.late)}</small></article>}
  {access.has("inventory.view")&&summary.inventory&&<article className="summary-card"><p>Риск по ОСГ</p><strong>{number(summary.inventory.risk)}</strong><small>критические и просроченные партии</small></article>}
  {access.has("tasks.view")&&summary.tasks&&<article className="summary-card"><p>Открытые задачи</p><strong>{number(summary.tasks.open)}</strong><small className={summary.tasks.late?"danger-text":""}>просрочено: {number(summary.tasks.late)}</small></article>}
  {access.has("integrations.view")&&<article className="summary-card"><p>Проблемные синхронизации</p><strong>{number(failedSyncs.length)}</strong><small>среди последних {number(syncs.length)} запусков</small></article>}
 </section>
 <section className="content-grid analytics-grid">
  {access.has("shipments.view")&&<section className="panel"><div className="panel-heading"><div><p className="eyebrow">Логистика</p><h2>Поставки по статусам</h2></div><Link className="text-button" href="/shipments">Открыть поставки</Link></div><div className="analytics-bars">{summary.shipments?.byStatus.map(([key,value])=><div key={key}><span>{shipmentLabels[key]??key}</span><b>{number(value)}</b><i style={{width:`${Math.max(6,value/Math.max(1,summary.shipments?.total??0)*100)}%`}}/></div>)}{!summary.shipments?.total&&<p className="empty-state">Данных пока нет.</p>}</div></section>}
  {access.has("sales.view")&&<section className="panel"><div className="panel-heading"><div><p className="eyebrow">Продажи</p><h2>Заказы по статусам</h2></div><Link className="text-button" href="/sales">Открыть заказы</Link></div><div className="analytics-bars">{summary.sales?.byStatus.map(([key,value])=><div key={key}><span>{saleLabels[key]??key}</span><b>{number(value)}</b><i style={{width:`${Math.max(6,value/Math.max(1,summary.sales?.total??0)*100)}%`}}/></div>)}{!summary.sales?.total&&<p className="empty-state">Данных пока нет.</p>}</div></section>}
 </section>
 {access.has("inventory.view")&&<section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Остатки</p><h2>Ближайшие риски по сроку годности</h2></div><Link className="text-button" href="/inventory">Открыть FIFO</Link></div><div className="import-table-wrap"><table className="import-table"><thead><tr><th>Товар</th><th>Партия</th><th>Склад</th><th>Годен до</th><th>Доступно</th><th>Риск</th></tr></thead><tbody>{riskInventory.map(row=><tr key={row.balance_id}><td><strong>{row.internal_sku}</strong><br/>{productName(row.product_name)}</td><td>{row.batch_number}</td><td>{row.warehouse_code}</td><td>{date(row.expiry_date)}</td><td>{row.quantity_available} {row.uom}</td><td><span className={`status ${row.shelf_life_state==="expired"?"danger-text":"warning"}`}>{row.shelf_life_state==="expired"?"Просрочено":"Критично"}</span></td></tr>)}</tbody></table>{!riskInventory.length&&<p className="empty-state">Критических и просроченных партий нет.</p>}</div></section>}
 </section></main>;
}
