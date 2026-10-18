import Link from "next/link";
import { notFound } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { loadShipmentReport, localizedName, one, type ReportReceiptItem } from "@/lib/shipment-report";
import { loadShipmentOutcome } from "@/lib/shipment-outcome";
import { ShipmentOutcomeSections } from "@/components/reports/shipment-outcome-sections";

const shipmentStatus: Record<string, string> = { planning:"Планирование",in_production:"У производителя",preparing_transport:"Подготовка перевозки",in_transit:"В пути",customs:"Таможня",receiving:"Приёмка",sales:"Реализация",closed:"Закрыта",on_hold:"Приостановлена",cancelled:"Отменена" };
const stageStatus: Record<string, string> = { pending:"Ожидает",in_progress:"В работе",blocked:"Заблокирован",completed:"Завершён",skipped:"Пропущен",not_applicable:"Не требуется" };
const units: Record<string, string> = { piece:"шт.",box:"кор.",layer:"слой",pallet:"пал.",truck:"авто" };
const date = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU").format(new Date(value)) : "—";
const dateTime = (value: string | null | undefined) => value ? new Intl.DateTimeFormat("ru-RU", { dateStyle:"medium", timeStyle:"short" }).format(new Date(value)) : "—";
const number = (value: unknown) => Number(value ?? 0).toLocaleString("ru-RU", { maximumFractionDigits: 3 });
const duration = (start: string | null | undefined, end: string | null | undefined) => {
  if (!start || !end) return "—";
  const hours = Math.max(0, (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000);
  return hours >= 24 ? `${(hours / 24).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} дн.` : `${hours.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} ч.`;
};

export default async function ShipmentReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { profile, roles, supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["prices.purchase.view", "inventory.view", "products.view", "sales.view", "costing.view", "documents.view"] as const);
  const granted = new Set(Object.keys(permissions).filter((key) => permissions[key as keyof typeof permissions]));
  const report = await loadShipmentReport(supabase, id, granted);
  if (!report) notFound();
  const outcome = await loadShipmentOutcome(supabase, id, report.items.map((item) => item.id), granted);
  const supplier = one(report.shipment.supplier);
  const customer = one(report.shipment.customer);
  const route = one(report.shipment.route);
  const warehouse = one(report.shipment.warehouse);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="shipments"/><section className="workspace admin-workspace report-workspace">
    <header className="topbar"><div><p className="eyebrow">Фаза 4 · Контроль поставки</p><h1>Отчёт {report.shipment.shipment_number}</h1></div><div className="topbar-actions"><a className="primary button-link" href={`/shipments/${id}/report/export`}>Скачать XLSX</a><Link className="ghost button-link" href={`/shipments/${id}`}>К карточке</Link></div></header>
    <section className="shipment-summary-grid report-summary">
      <article className="summary-card"><p>Статус</p><strong>{shipmentStatus[report.shipment.status] ?? report.shipment.status}</strong><small>Проект: {report.shipment.project_code || "—"}</small></article>
      <article className="summary-card"><p>Контрагенты</p><strong>{supplier?.short_name || supplier?.legal_name || "—"}</strong><small>Клиент: {customer?.short_name || customer?.legal_name || "—"}</small></article>
      <article className="summary-card"><p>Маршрут</p><strong>{localizedName(route?.name)}</strong><small>Склад: {warehouse?.code || "—"} · {localizedName(warehouse?.name)}</small></article>
      <article className={`summary-card report-control ${report.totals.reconciled ? "is-ok" : "has-warning"}`}><p>Контроль остатков</p><strong>{!report.totals.hasReceipt ? "Ожидает приёмки" : report.totals.reconciled ? "Сходится" : "Есть расхождение"}</strong><small>Принято {number(report.totals.accepted)} · партии {number(report.totals.batches)} · движения {number(report.totals.movements)}</small></article>
    </section>

    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Количественная сверка</p><h2>Позиции</h2></div><span className="page-count">{report.items.length}</span></div>
      <div className="import-table-wrap"><table className="import-table report-table"><thead><tr><th>Товар</th><th>Автомобиль</th><th>Заказано</th><th>Подтверждено</th><th>Отгружено</th><th>Принято</th><th>Расхождение</th>{report.canViewPrices && <th>Цена</th>}</tr></thead><tbody>{report.items.map((item) => { const product = one(item.product); const transport = one(item.transport); return <tr className={item.discrepancy ? "has-error" : ""} key={item.id}><td><strong>{product?.internal_sku}</strong><br/>{localizedName(product?.name)}</td><td>{transport ? `№${transport.sequence_no}` : "—"}</td><td>{number(item.ordered_quantity)} {units[item.uom] ?? item.uom}</td><td>{item.confirmed_quantity == null ? "Не заполнено" : number(item.confirmed_quantity)}</td><td>{item.shipped_quantity == null ? "Не заполнено" : number(item.shipped_quantity)}</td><td>{number(item.accepted)}</td><td>{item.discrepancy > 0 ? "+" : ""}{number(item.discrepancy)}{item.discrepancy_reason ? <><br/><small>{item.discrepancy_reason}</small></> : null}</td>{report.canViewPrices && <td>{item.unit_price == null ? "—" : number(item.unit_price)}</td>}</tr>; })}</tbody></table></div>
    </section>

    <section className="report-columns">
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Логистика</p><h2>Автомобили</h2></div><span className="page-count">{report.transports.length}</span></div><div className="report-list">{report.transports.map((transport) => <article key={transport.id}><strong>Автомобиль №{transport.sequence_no}</strong><span>{date(transport.actual_loading_date ?? transport.planned_loading_date)} → {date(transport.actual_arrival_date ?? transport.planned_arrival_date)}</span><small>{transport.notes || transport.status}</small></article>)}</div></section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Документооборот</p><h2>Документы</h2></div><span className="page-count">{report.documents.length}</span></div><div className="report-list">{report.documents.map((document) => <article key={document.id}><strong>{document.title}</strong><span>{one(document.type)?.name_ru || one(document.type)?.code || "Документ"} · {document.status}</span><small>Версия {document.current_version} · {date(document.document_date)}</small></article>)}{!report.documents.length && <p className="empty-state">Документы к поставке не привязаны.</p>}</div>{report.missingDocuments.length > 0 && <div className="report-missing"><strong>Не хватает обязательных документов:</strong>{report.missingDocuments.map(({ requirement, transport }, index) => <span key={`${requirement.document_type_id}-${transport?.id ?? "shipment"}-${index}`}>{one(requirement.type)?.name_ru || one(requirement.type)?.code || "Документ"}{transport ? ` · автомобиль №${transport.sequence_no}` : ""}</span>)}</div>}</section>
    </section>

    <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Процесс RVI</p><h2>Этапы</h2></div><span className="page-count">{report.stages.filter((stage) => stage.status === "completed").length} из {report.stages.length}</span></div><div className="import-table-wrap"><table className="import-table report-table"><thead><tr><th>№</th><th>Этап</th><th>Статус</th><th>Начало</th><th>Завершение</th><th>Длительность</th><th>Причина / исполнитель</th></tr></thead><tbody>{[...report.stages].sort((a,b) => (one(a.stage)?.sequence_order ?? 0) - (one(b.stage)?.sequence_order ?? 0)).map((run) => { const stage = one(run.stage); const transport = one(run.transport); return <tr key={run.id}><td>{stage?.sequence_order}</td><td>{localizedName(stage?.name)}{transport ? <><br/><small>Автомобиль №{transport.sequence_no}</small></> : null}</td><td><span className={`status stage-badge-${run.status}`}>{stageStatus[run.status] ?? run.status}</span></td><td>{dateTime(run.started_at)}</td><td>{dateTime(run.completed_at)}</td><td>{duration(run.started_at, run.completed_at)}</td><td>{run.status_reason || run.performed_by_name || "—"}</td></tr>; })}</tbody></table></div></section>

    <section className="report-columns">
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Приёмка</p><h2>Партии</h2></div><span className="page-count">{report.receipts.length} приёмок</span></div><div className="report-list">{report.receipts.flatMap((receipt) => (receipt.items ?? []).map((item: ReportReceiptItem, index: number) => { const batch = one(item.batch); return <article key={`${receipt.id}-${index}`}><strong>{batch?.batch_number || "Без партии"}</strong><span>Принято {number(item.accepted_quantity)} · повреждено {number(item.damaged_quantity)}</span><small>Годен до {date(batch?.expiry_date)} · {receipt.performed_by_name}</small></article>; }))}{!report.receipts.length && <p className="empty-state">Приёмка ещё не проводилась.</p>}</div></section>
      <section className="panel admin-section"><div className="panel-heading"><div><p className="eyebrow">Контроль исполнения</p><h2>Открытые задачи</h2></div><span className="page-count">{report.tasks.length}</span></div><div className="report-list">{report.tasks.map((task) => <article key={task.id}><strong>{task.title}</strong><span>{task.status === "in_progress" ? "В работе" : "Открыта"} · {task.priority}</span><small>{one(task.assignee)?.full_name || "Без исполнителя"} · срок {dateTime(task.due_at)}</small></article>)}{!report.tasks.length && <p className="empty-state">Открытых задач нет.</p>}</div></section>
    </section>

    <ShipmentOutcomeSections outcome={outcome} items={report.items}/>
  </section></main>;
}
