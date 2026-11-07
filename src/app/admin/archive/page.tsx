import { WorkflowHelp } from "@/components/workflow-help";
import { DocumentActions } from "@/components/documents/document-actions";
import { loadDocumentActions } from "@/lib/documents/load-actions";
import Link from "next/link";
import { AppSidebar } from "@/components/app-sidebar";
import { requireUser } from "@/lib/auth/access";

type Row = Record<string, unknown>;
type Archive = { id: string; title: string; reason: string; created_at: string; records: Record<string, Row[]> };
const labels: Record<string,string> = {
  assistant_operations:"История действий ассистента",
  shipments:"Поставки", shipment_items:"Товары поставок", shipment_transports:"Автомобили", shipment_stage_runs:"Этапы",
  sales:"Заказы покупателей", sale_items:"Товары заказов", inventory_batches:"Партии", inventory_balances:"Остатки на момент архива",
  inventory_movements:"История движений", inventory_operation_documents:"Складские документы", expenses:"Расходы",
  documents:"Документы", document_versions:"Версии файлов", document_links:"Связи документов", document_generations:"Формирование документов",
  shipment_source_extractions:"Распознавание и ручные подтверждения", shipment_item_quantity_confirmations:"Подтверждения количеств",
  shipment_drive_folders:"Привязка папок Google Drive", shipment_drive_files:"Сопоставленные файлы", shipment_drive_operations:"История чтения папок",
  shipment_document_checks:"Результаты сверки", approvals:"Согласования", notifications:"Уведомления", audit_log:"Журнал действий",
};
export default async function ArchivePage({searchParams}:{searchParams:Promise<{id?:string}>}) {
  const {profile,roles,supabase}=await requireUser();
  const params=await searchParams;
  const list=await supabase.rpc("list_operational_archives");
  const id=params.id && /^[0-9a-f-]{36}$/i.test(params.id)?params.id:undefined;
  const detail=id&&!list.error?await supabase.rpc("read_operational_archive",{p_archive_id:id}):null;
  const archive=detail?.data as Archive|null;
  const documentActions = await loadDocumentActions(supabase, (archive?.records.documents ?? []).map(row => typeof row.id === "string" ? row.id : null));
  return <main className="app-shell"><AppSidebar profile={profile} roles={roles} active="operational-archive"/><section className="workspace">
    <header className="topbar"><div><p className="eyebrow">Сохранённая история</p><h1>Архив учебных проектов</h1></div><Link className="ghost button-link" href="/shipments">К рабочим поставкам</Link></header>
    <WorkflowHelp section="operationalArchive"/>
    <article className="panel"><p>Архив не участвует в рабочих остатках, продажах, расходах и итогах. Записи доступны только для чтения. Документы можно открыть по прежним ссылкам.</p>
      {list.error?<p role="alert">Нет доступа к полному архиву. Нужны права администратора и просмотра всех сохранённых сведений, включая цены.</p>:
        <ul>{(list.data??[]).map((a:{id:string;title:string;created_at:string})=><li key={a.id}><Link href={`/admin/archive?id=${a.id}`}>{a.title}</Link> · {new Date(a.created_at).toLocaleDateString("ru-RU")}</li>)}</ul>}
      {detail?.error&&<p role="alert">Не удалось прочитать архив.</p>}
    </article>
    {archive&&<article className="panel"><h2>{archive.title}</h2><p>{archive.reason}</p>
      {Object.entries(archive.records).sort(([a],[b]) => (a === "shipments" ? -1 : b === "shipments" ? 1 : a === "documents" ? -1 : b === "documents" ? 1 : 0)).map(([table,rows])=><details key={table} style={{marginBlock:"1rem"}}><summary>{labels[table]??table} — {rows.length}</summary>
        {rows.map((row,index)=><details key={String(row.id??index)} style={{margin:"0.5rem 0 0.5rem 1rem"}}><summary>{String(row.project_code||row.shipment_number||row.order_number||row.sale_number||row.batch_number||row.title||row.name||row.id||`Запись ${index+1}`)}</summary>
          {table==="documents"&&typeof row.id==="string"&&<DocumentActions document={documentActions[row.id]} version={typeof row.current_version === "number" ? row.current_version : null}/>}
          <details><summary>Полная сохранённая запись</summary><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere",fontSize:"0.85rem"}}>{JSON.stringify(row,null,2)}</pre></details>
        </details>)}
      </details>)}
    </article>}
  </section></main>;
}
