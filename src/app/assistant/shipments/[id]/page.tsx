import { WorkflowHelp } from "@/components/workflow-help";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppSidebar } from "@/components/app-sidebar";
import { ShipmentWorkflowScope } from "@/components/assistant/shipment-workflow-scope";
import { ShipmentDriveFolderPanel } from "@/components/documents/shipment-drive-folder-panel";
import { ShipmentSourceDocumentsPanel } from "@/components/documents/shipment-source-documents-panel";
import { ShipmentDocumentCheckPanel } from "@/components/documents/shipment-document-check-panel";
import { requirePageUser } from "@/lib/auth/access";
import { isUuid } from "@/lib/documents/rules";
import { folderHint, workspacePath } from "@/lib/agent/shipment-workflow";

export const dynamic = "force-dynamic";
type Query = { step?: string; folder?: string; success?: string; error?: string; source_success?: string; source_error?: string; check_success?: string; check_error?: string };

export default async function ShipmentWorkspace({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Query> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { profile, roles, supabase, permissions: can } = await requirePageUser(["agent.use", "shipments.view", "documents.view", "shipments.update", "documents.drive.view", "prices.purchase.view"] as const);
  if (!can["agent.use"] || !can["shipments.view"] || process.env.AGENT_OPERATIONS_ENABLED !== "true") redirect("/assistant");
  const { data: shipment, error } = await supabase.from("shipments").select("id,shipment_number,project_code,status,is_locked").eq("id", id).maybeSingle();
  if (error || !shipment) notFound();
  const query = await searchParams;
  const step = query.step === "review" || query.step === "operations" ? query.step : "files";
  const folder = folderHint(query.folder);
  const canDrive = ["documents.view", "shipments.update", "documents.drive.view", "prices.purchase.view"].every(key => can[key as keyof typeof can]);
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="assistant" />
    <section className="workspace admin-workspace">
      <header className="topbar"><div><p className="eyebrow">Ассистент · подготовка поставки</p><h1>{shipment.project_code || shipment.shipment_number}</h1><p>{shipment.shipment_number}</p></div><Link href={`/shipments/${id}`}>Карточка поставки</Link></header>
    <WorkflowHelp section="shipmentWorkspace"/>
      <nav aria-label="Подготовка поставки" className="workflow-steps">
        <Link href="/assistant/shipments">Выбор поставки</Link>
        <Link aria-current={step === "files" ? "step" : undefined} href={workspacePath(id)}>1. Папка и файлы</Link>
        <Link aria-current={step === "review" ? "step" : undefined} href={workspacePath(id, "review")}>2. Чтение и сверка</Link>
        <Link aria-current={step === "operations" ? "step" : undefined} href={workspacePath(id, "operations")}>3. Учётные операции</Link>
      </nav>
      <p className="setup-notice">Открытие шага ничего не проводит. Результаты загрузки и проверки сохраняются в Nexus; после перерыва вернитесь к этой поставке. Подтверждение чтения документа не подтверждает приход, продажу или оплату.</p>
      {(query.error || query.success) && <p role="status" className={query.error ? "login-error" : "login-success"}>{(query.error || query.success || "").slice(0, 1500)}</p>}
      <ShipmentWorkflowScope shipmentId={id}>
        {step === "files" && <>{canDrive ? <ShipmentDriveFolderPanel shipmentId={id} initialFolder={folder ? `https://drive.google.com/drive/folders/${folder}` : undefined} /> : <p role="status">Нет доступа к привязке Drive. Нужны права на изменение поставки, документы, архив и закупочные сведения. Права автоматически не расширяются.</p>}<Link className="primary button-link" href={workspacePath(id, "review")}>Перейти к чтению и сверке</Link></>}
        {step === "review" && <>{can["documents.view"] ? <><ShipmentDocumentCheckPanel shipmentId={id} notice={query.check_error ? { kind: "error", message: query.check_error.slice(0, 1500) } : query.check_success ? { kind: "success", message: query.check_success.slice(0, 1500) } : undefined}/><ShipmentSourceDocumentsPanel shipmentId={id} workspace notice={query.source_error ? { kind: "error", message: query.source_error.slice(0, 1500) } : query.source_success ? { kind: "success", message: query.source_success.slice(0, 1500) } : undefined} /></> : <p>Нет доступа к документам.</p>}
          <section className="panel admin-section"><h2>Проверьте основу сверки</h2><p>Инвойс и упаковочный лист должны относиться к нужной машине. Заказ отражает потребность; разница с ним не является складской недостачей. Перевод не добавляет второй груз.</p><p>Состав товаров, распределение по автомобилям и фактические даты редактируются в карточке. Пустые данные не означают готовность к приёмке.</p><Link href={`/shipments/${id}?tab=items`}>Товары и автомобили поставки</Link><p><Link href={`/shipments/prepare?shipment=${id}`}>Сохранить проект разбора исторической поставки</Link></p><Link className="primary button-link" href={workspacePath(id, "operations")}>Перейти к учётным операциям</Link></section>
        </>}
      </ShipmentWorkflowScope>
      {step === "operations" && <section className="panel admin-section"><h2>Каждое проведение — отдельно</h2><p>Прочитанные документы не доказывают фактическое получение товара. Перед приёмкой нужны годное количество, брак, партия, срок, склад и основание даты.</p>
        <p><Link href={`/shipments/${id}?tab=delivery`}>Проверить и подготовить приёмку в карточке</Link></p>
        <p><Link href={`/assistant?shipment=${id}`}>Продолжить с ассистентом по этой поставке</Link></p>
        <p>В диалоге доступны подготовка приёмки машины, заказа покупателя, резерва, подтверждения и отгрузки. Каждая операция требует собственного предпросмотра и кнопки подтверждения. Историческая продажа и исключение по фактической приёмке без письма оформляются только администратором в штатной форме.</p>
        <p><Link href={`/shipments/${id}/report`}>Итог поставки и оставшиеся замечания</Link></p>
        <p>Этот экран не объявляет полный комплект готовым и не выполняет переходы автоматически. Платёж вносится только по отдельному основанию.</p>
      </section>}
    </section></main>;
}
