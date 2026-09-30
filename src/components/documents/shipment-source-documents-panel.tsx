import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { confirmShipmentSourceAction, extractShipmentSourcesAction } from "@/app/shipments/source-document-actions";

const statusLabel: Record<string, string> = {
  pending: "Ожидает", extracted: "Распознано", needs_review: "Нужна проверка",
  confirmed: "Принято автоматически", failed: "Не прочитано", superseded: "Устарело",
};
const sourceLabel: Record<string, string> = {
  invoice: "Инвойс", specification: "Спецификация", contract: "Договор",
  transport_order: "Договор-заявка", vehicle_document: "Документы автомобиля",
  driver_document: "Документы водителя", waybill: "Накладная", other: "Прочий источник",
};

export async function ShipmentSourceDocumentsPanel({ shipmentId }: { shipmentId: string }) {
  const supabase = await createClient();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "source_documents.review", "documents.create", "documents.view"] as const);
  if (!permissions["documents.view"]) return null;
  const { data, error } = await supabase
    .from("shipment_source_extractions")
    .select("id,document_id,source_kind,status,extracted_data,conflicts,error_message,updated_at,document:documents(title,original_filename)")
    .eq("shipment_id", shipmentId)
    .neq("status", "superseded")
    .order("updated_at", { ascending: false });
  const rows = (data ?? []) as Array<{
    id: string; source_kind: string; status: string; extracted_data: Record<string, unknown>;
    conflicts: unknown[]; error_message: string | null; document: { title: string; original_filename: string | null } | Array<{ title: string; original_filename: string | null }> | null;
  }>;
  const one = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] : value;
  return <section className="panel admin-section" id="source-documents">
    <div className="panel-heading"><div><p className="eyebrow">Источник данных</p><h2>Загруженные документы перевозки</h2></div><div className="topbar-actions">
      {permissions["documents.create"]&&<Link className="ghost button-link compact" href={`/documents?link=shipment:${shipmentId}#register`}>+ Загрузить источник</Link>}
      {permissions["source_documents.extract"]&&<form action={extractShipmentSourcesAction}><input type="hidden" name="shipment_id" value={shipmentId}/><button className="primary compact" type="submit">Распознать и сверить</button></form>}
    </div></div>
    <p className="form-help">Инвойсы, договор-заявка и документы автомобиля читаются автоматически. Совпавшие данные принимаются без ручного ввода; сотрудник проверяет только расхождения и непрочитанные файлы.</p>
    {error&&<div className="setup-notice">Примените миграцию <strong>202609273600_source_document_extraction.sql</strong>.</div>}
    {!error&&<div className="compact-list">{rows.map(row=>{const document=one(row.document);const fields=Object.keys(row.extracted_data??{}).length;const conflicts=Array.isArray(row.conflicts)?row.conflicts.length:0;return <div className="doc-link-row" key={row.id}><div><strong>{document?.title??sourceLabel[row.source_kind]??"Исходный документ"}</strong><small>{sourceLabel[row.source_kind]??row.source_kind} · найдено полей: {fields}{conflicts?` · расхождений: ${conflicts}`:""}</small>{row.error_message&&<small>{row.error_message}</small>}</div><span className={`doc-badge doc-status-${row.status}`}>{statusLabel[row.status]??row.status}</span>{permissions["source_documents.review"]&&["extracted","needs_review"].includes(row.status)&&<form action={confirmShipmentSourceAction}><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={row.id}/><button className="ghost compact" type="submit">Подтвердить исключение</button></form>}</div>;})}{!rows.length&&<div className="empty-state">Загрузите исходные документы поставки, затем нажмите «Распознать и сверить».</div>}</div>}
  </section>;
}
