import { PendingSubmitButton } from "@/components/pending-submit-button";
import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { folderHint } from "@/lib/agent/shipment-workflow";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { createShipment } from "./actions";
import { selectAll } from "@/lib/supabase/select-all";
import { loadPermissions } from "@/lib/permissions";

const statusLabels:Record<string,string>={planning:"Планирование",in_production:"У производителя",preparing_transport:"Подготовка перевозки",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Реализация",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
function localizedName(value:unknown){if(!value||typeof value!=="object")return "—";const name=value as Record<string,unknown>;return String(name.ru??name.en??"—");}
function one<T>(value:T|T[]|null|undefined){return Array.isArray(value)?value[0]:value??undefined;}

export default async function ShipmentsPage({searchParams}:{searchParams:Promise<{error?:string;success?:string;status?:string;assistant?:string;folder?:string}>}){
  const {profile,roles,supabase}=await requireUser(); const params=await searchParams;
  const preparationAccess = process.env.AGENT_OPERATIONS_ENABLED === "true"
    ? await loadPermissions(supabase, ["agent.use", "shipments.view"] as const) : null;
  let query=supabase.from("shipments").select("id,shipment_number,project_code,type,status,planned_arrival_date,created_at,supplier:counterparties!shipments_supplier_id_fkey(short_name,legal_name),route:routes(name),warehouse:warehouses(name),responsible:profiles!shipments_responsible_user_id_fkey(full_name)").order("created_at",{ascending:false});
  if(params.status)query=query.eq("status",params.status);
  const [{data:shipments,error},{data:counterparties},{data:routes},{data:warehouses},{data:currencies},{data:profiles}]=await Promise.all([
    query,
    selectAll((from,to)=>supabase.from("counterparties").select("id,legal_name,short_name,roles").eq("status","active").order("legal_name").order("id").range(from,to)),
    supabase.from("routes").select("id,name").eq("status","active").order("origin_country"),
    supabase.from("warehouses").select("id,name,is_virtual").eq("status","active").eq("is_virtual",false).order("code"),
    supabase.from("currencies").select("id,code").eq("is_active",true).order("code"),
    supabase.from("profiles").select("id,full_name").eq("is_active",true).order("full_name"),
  ]);
  const suppliers=counterparties?.filter((party)=>party.roles?.includes("manufacturer"))??[];
  const customers=counterparties?.filter((party)=>party.roles?.includes("customer"))??[];
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace">
    <header className="topbar"><div><p className="eyebrow">Закупки и логистика</p><h1>Поступления и поставки</h1></div><div className="topbar-actions"><span className="page-count">{shipments?.length??0} поставок</span></div></header>
    <WorkflowHelp section="shipments"/>
    <div className="topbar-actions">
      {preparationAccess?.["agent.use"] && preparationAccess["shipments.view"] && <Link className="primary button-link" href="/assistant/shipments">Подготовить из папки Google Drive</Link>}
      <Link className="ghost button-link" href="/shipments/prepare">Подготовить историческую поставку</Link>
    </div>
    {params.error&&<div className="login-error admin-message">{params.error}</div>}{params.success&&<div className="login-success admin-message">{params.success}</div>}
    {error&&<div className="setup-notice">Не удалось загрузить данные раздела. Обновите страницу. Если ошибка повторится, сообщите администратору название раздела.</div>}
    <details id="create-shipment" open={params.assistant==="1"} className="panel admin-section create-disclosure"><summary><span><small>Новая операция</small><strong>Оформить поступление или поставку</strong></span><b aria-hidden="true">+</b></summary><div className="create-disclosure-body">
      <form action={createShipment} className="shipment-form">
        {params.assistant==="1"&&<><input type="hidden" name="assistant_workflow" value="1"/><label className="doc-form-full">Ссылка на папку Google Drive<input type="url" name="folder" defaultValue={folderHint(params.folder)?`https://drive.google.com/drive/folders/${folderHint(params.folder)}`:""} placeholder="https://drive.google.com/drive/folders/…"/><small>После создания откроется подготовка документов. Там проверьте и подтвердите привязку этой папки.</small></label><p className="doc-form-full">Сначала проверьте список существующих поставок. Для новой заполните маршрут, склад назначения и валюту.</p></>}
        <label>Код проекта<input name="project_code" placeholder="RVI-01"/></label>
        <label>Тип<select name="type" defaultValue="import"><option value="import">Импорт</option><option value="export">Экспорт</option><option value="domestic_transfer">Перемещение по Казахстану</option></select></label>
        <label>Поставщик<select name="supplier_id" defaultValue=""><option value="">Выберите</option>{suppliers.map((party)=><option key={party.id} value={party.id}>{party.short_name||party.legal_name}</option>)}</select></label>
        <label>Клиент<select name="customer_id" defaultValue=""><option value="">Не выбран</option>{customers.map((party)=><option key={party.id} value={party.id}>{party.short_name||party.legal_name}</option>)}</select></label>
        <label>Маршрут (обязательно)<select name="route_id" required defaultValue=""><option value="" disabled>Выберите маршрут</option>{routes?.map((route)=><option key={route.id} value={route.id}>{localizedName(route.name)}</option>)}</select></label>
        <label>Склад назначения (обязательно)<select name="warehouse_id" required defaultValue=""><option value="" disabled>Выберите склад</option>{warehouses?.map((warehouse)=><option key={warehouse.id} value={warehouse.id}>{localizedName(warehouse.name)}</option>)}</select></label>
        <label>Валюта (обязательно)<select name="currency_id" required defaultValue=""><option value="" disabled>Выберите валюту</option>{currencies?.map((currency)=><option key={currency.id} value={currency.id}>{currency.code}</option>)}</select></label>
        <label>Ответственный<select name="responsible_user_id" defaultValue={profile.id}>{profiles?.map((person)=><option key={person.id} value={person.id}>{person.full_name}</option>)}</select></label>
        <label>Готовность товара<input name="planned_ready_date" type="date"/></label><label>Прибытие в Казахстан<input name="planned_arrival_date" type="date"/></label>
        <PendingSubmitButton pendingText="Выполняем…" className="primary" type="submit">Создать поставку</PendingSubmitButton>
      </form><p className="form-help">Номер и 18 этапов процесса создаются автоматически. Условные этапы можно включить позже.</p>
    </div></details>
    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Реестр</p><h2>Поставки в работе</h2></div><div className="shipment-filters"><Link href="/shipments">Все</Link><Link href="/shipments?status=planning">Планирование</Link><Link href="/shipments?status=in_transit">В пути</Link><Link href="/shipments?status=customs">Таможня</Link></div></div>
      <div className="shipment-list">{shipments?.map((shipment)=>{const supplier=one(shipment.supplier);const route=one(shipment.route);const warehouse=one(shipment.warehouse);const responsible=one(shipment.responsible);return <Link className="shipment-row" href={`/shipments/${shipment.id}`} key={shipment.id}>
        <div><strong>{shipment.shipment_number}</strong><small>{shipment.project_code||"Без кода проекта"}</small></div>
        <div><strong>{supplier?.short_name||supplier?.legal_name||"Внутренняя перевозка"}</strong><small>{localizedName(route?.name)} → {localizedName(warehouse?.name)}</small></div>
        <div><span className={`status shipment-${shipment.status}`}>{statusLabels[shipment.status]??shipment.status}</span><small>{responsible?.full_name||"—"}</small></div>
        <div className="shipment-date"><strong>{shipment.planned_arrival_date?new Intl.DateTimeFormat("ru-RU").format(new Date(shipment.planned_arrival_date)):"Дата не задана"}</strong><small>плановое прибытие</small></div>
      </Link>;})}{!shipments?.length&&!error&&<div className="empty-state">Поставок пока нет. Создайте первую поставку RVI выше.</div>}</div>
    </section>
  </section></main>;
}
