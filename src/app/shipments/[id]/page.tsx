import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { changeStageStatus } from "../actions";

const shipmentStatus:Record<string,string>={planning:"Планирование",in_production:"У производителя",preparing_transport:"Подготовка перевозки",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Реализация",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
const stageStatus:Record<string,string>={pending:"Ожидает",in_progress:"В работе",blocked:"Заблокирован",completed:"Завершён",skipped:"Пропущен",not_applicable:"Не требуется"};
function name(value:unknown){if(!value||typeof value!=="object")return "—";const v=value as Record<string,unknown>;return String(v.ru??v.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}

export default async function ShipmentPage({params,searchParams}:{params:Promise<{id:string}>;searchParams:Promise<{error?:string;success?:string}>}){
  const {id}=await params; const notices=await searchParams; const {profile,roles,supabase}=await requireUser();
  const [{data:shipment,error},{data:runs}]=await Promise.all([
    supabase.from("shipments").select("id,shipment_number,project_code,type,status,planned_ready_date,planned_arrival_date,created_at,supplier:counterparties!shipments_supplier_id_fkey(legal_name,short_name),customer:counterparties!shipments_customer_id_fkey(legal_name,short_name),route:routes(name),warehouse:warehouses(name),currency:currencies(code),responsible:profiles!shipments_responsible_user_id_fkey(full_name)").eq("id",id).maybeSingle(),
    supabase.from("shipment_stage_runs").select("id,status,is_required,status_reason,started_at,completed_at,performed_by_name,stage:shipment_stages(code,name,sequence_order,requirement,status_category,scope)").eq("shipment_id",id).order("stage(sequence_order)"),
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
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Процесс RVI</p><h2>Этапы поставки</h2></div><span className="page-count">{runs?.filter((run)=>run.status==="completed").length??0} из {runs?.length??0} завершено</span></div>
      <div className="stage-list">{runs?.map((run)=>{const stage=one(run.stage);return <article className={`stage-row stage-${run.status}`} key={run.id}>
        <div className="stage-number">{stage?.sequence_order}</div><div className="stage-copy"><strong>{name(stage?.name)}</strong><small>{stage?.scope==="transport"?"По перевозке":"По поставке"} · {stage?.requirement==="required"?"обязательный":stage?.requirement==="conditional"?"по условию":"необязательный"}</small>{run.status_reason&&<p>{run.status_reason}</p>}</div>
        <span className={`status stage-badge-${run.status}`}>{stageStatus[run.status]??run.status}</span>
        <form action={changeStageStatus} className="stage-action"><input type="hidden" name="run_id" value={run.id}/><input type="hidden" name="shipment_id" value={shipment.id}/><select name="status" defaultValue={run.status}><option value="pending">Ожидает</option><option value="in_progress">В работе</option><option value="completed">Завершён</option><option value="blocked">Заблокирован</option><option value="skipped">Пропущен</option><option value="not_applicable">Не требуется</option></select><input name="reason" placeholder="Причина, если требуется"/><button className="ghost compact" type="submit">Сохранить</button></form>
      </article>;})}</div>
    </section>
  </section></main>;
}
