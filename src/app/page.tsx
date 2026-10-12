import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { calendarStatusLabel,type CalendarEvent } from "@/lib/calendar/rules";

const shipmentLabels:Record<string,string>={planning:"Планирование",in_production:"У производителя",preparing_transport:"Подготовка перевозки",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Реализация",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена"};
const one=<T,>(value:T|T[]|null|undefined):T|undefined=>Array.isArray(value)?value[0]:value??undefined;
// "1 событие", "3 события", "5 событий"
const plural=(n:number,[one,few,many]:[string,string,string])=>{const r10=n%10,r100=n%100;return `${n} ${r10===1&&r100!==11?one:r10>=2&&r10<=4&&(r100<12||r100>14)?few:many}`};
const date=(value:string)=>new Intl.DateTimeFormat("ru-RU",{day:"numeric",month:"short",timeZone:"Asia/Qyzylorda"}).format(new Date(value));

export default async function Home() {
  const { profile, roles, supabase } = await requireUser();
  const can=await loadPermissions(supabase,["shipments.view","tasks.view","calendar.view"] as const);
  const now=new Date();const from=new Date(now);from.setDate(from.getDate()-7);const to=new Date(now);to.setDate(to.getDate()+31);
  const empty=Promise.resolve({data:[],error:null,count:0});
  const [shipmentResult,taskResult,overdueTaskResult,eventResult]=await Promise.all([
    can["shipments.view"]?supabase.from("shipments").select("id,shipment_number,project_code,status,planned_arrival_date,supplier:counterparties!shipments_supplier_id_fkey(short_name,legal_name),route:routes(name)",{count:"exact"}).not("status","in",'(closed,cancelled)').order("updated_at",{ascending:false}).limit(8):empty,
    can["tasks.view"]?supabase.from("tasks").select("id,title,due_at,status,shipment_id",{count:"exact"}).in("status",["open","in_progress"]).order("due_at",{ascending:true,nullsFirst:false}).limit(8):empty,
    can["tasks.view"]?supabase.from("tasks").select("id",{count:"exact",head:true}).in("status",["open","in_progress"]).lt("due_at",now.toISOString()):empty,
    can["calendar.view"]&&can["shipments.view"]?supabase.rpc("my_shipment_calendar",{p_from:from.toISOString(),p_to:to.toISOString()}):empty,
  ]);
  const shipments=shipmentResult.data??[];const tasks=taskResult.data??[];const events=(eventResult.data??[]) as CalendarEvent[];
  const urgentEvents=events.filter(event=>["overdue","due_soon"].includes(event.event_status));
  const nearest=events.filter(event=>!["completed","completed_late","cancelled"].includes(event.event_status)&&event.planned_at>=now.toISOString()).sort((a,b)=>a.planned_at.localeCompare(b.planned_at))[0];
  const overdueTasks=overdueTaskResult.count??0;
  const firstName=profile.full_name.split(/\s+/)[0];
  const currentDate=new Intl.DateTimeFormat("ru-RU",{weekday:"long",day:"numeric",month:"long",timeZone:"Asia/Qyzylorda"}).format(now);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="overview"/><section className="workspace" id="overview">
    <header className="topbar overview-topbar"><div><p className="eyebrow overview-date"><span className="brand-diamond" aria-hidden="true"/>{currentDate} · Добрый день, {firstName}</p><h1>Сводка дня</h1></div><div className="top-actions"><Link className="ghost button-link" href="/products">Поиск товара</Link>{can["shipments.view"]&&<Link className="primary button-link" href="/shipments">+ Новая поставка</Link>}</div></header>
    <section className="summary-grid" aria-label="Сводка">
      <article className="summary-card"><p>Активные поставки</p><strong>{shipmentResult.count??shipments.length}</strong><small className={urgentEvents.length?"warning-text":""}>{urgentEvents.length} сроков требуют внимания</small></article>
      <article className="summary-card"><p>В пути и на таможне</p><strong>{shipments.filter(item=>["in_transit","customs"].includes(item.status)).length}</strong><small className="info-text">операционные поставки</small></article>
      <article className="summary-card"><p>Ближайшее событие</p><strong>{nearest?date(nearest.planned_at):"—"}</strong><small>{nearest?`${nearest.shipment_number} · ${nearest.title}`:"сроки не заданы"}</small></article>
      <article className="summary-card"><p>Открытые задачи</p><strong>{taskResult.count??tasks.length}</strong><small className={overdueTasks?"danger-text":""}>{overdueTasks} просрочено</small></article>
    </section>
    <section className="content-grid" id="workspace">
      <article className="panel projects-panel"><div className="panel-heading"><h2>Поставки в работе</h2><Link className="text-button" href="/shipments">Все поставки →</Link></div>
        {shipments.length ? <div className="overview-table-wrap"><table className="overview-table"><thead><tr><th scope="col">Поставка</th><th scope="col">Поставщик</th><th scope="col">Маршрут</th><th scope="col">Прибытие</th><th scope="col">Статус</th></tr></thead><tbody>{shipments.slice(0,5).map(shipment=>{const supplier=one(shipment.supplier);const route=one(shipment.route);const routeName=(route?.name??{}) as Record<string,string>;return <tr key={shipment.id}><td><Link className="overview-shipment-link" href={`/shipments/${shipment.id}`}>{shipment.project_code||shipment.shipment_number}</Link></td><td>{supplier?.short_name||supplier?.legal_name||"Внутренняя перевозка"}</td><td className="muted-cell">{routeName.ru||routeName.en||"Маршрут не указан"}</td><td>{shipment.planned_arrival_date?date(shipment.planned_arrival_date):"—"}</td><td><span className={`status shipment-${shipment.status}`}>{shipmentLabels[shipment.status]??shipment.status}</span></td></tr>})}</tbody></table></div>
          : <p className="empty-state">Активных поставок нет.</p>}
      </article>
      <article className="panel alert-panel"><h2><span className="brand-diamond" aria-hidden="true"/>Требует внимания</h2><div className="alert"><strong>{plural(events.filter(e=>e.event_status==="overdue").length,["событие","события","событий"])}</strong><span>срок уже нарушен</span></div><div className="alert"><strong>{plural(events.filter(e=>e.event_status==="due_soon").length,["событие","события","событий"])}</strong><span>в ближайшие 3 дня</span></div><div className="alert"><strong>{plural(overdueTasks,["задача","задачи","задач"])}</strong><span>просрочены</span></div><Link className="alert-link" href="/calendar">Открыть календарь →</Link></article>
      <article className="panel tasks-panel"><div className="panel-heading"><h2>Ближайшие события</h2><Link className="text-button" href="/calendar">Открыть календарь →</Link></div><div className="dashboard-events">{events.filter(e=>!["completed","completed_late","cancelled"].includes(e.event_status)).sort((a,b)=>a.planned_at.localeCompare(b.planned_at)).slice(0,5).map(event=><Link className="dashboard-event" href={`/shipments/${event.shipment_id}`} key={`${event.source_type}-${event.source_id}-${event.event_kind}`}><time>{date(event.planned_at)}</time><div><strong>{event.title}</strong><small>{event.shipment_number} · {event.responsible_name||"без ответственного"}</small></div><span className={`doc-badge calendar-${event.event_status}`}>{calendarStatusLabel[event.event_status]}</span></Link>)}{!events.length&&<p className="empty-state">Событий на ближайший месяц нет.</p>}</div></article>
    </section>
  </section></main>;
}
