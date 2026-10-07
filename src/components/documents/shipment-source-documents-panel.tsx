import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { confirmShipmentSourceAction, extractShipmentSourcesAction } from "@/app/shipments/source-document-actions";
import { BulkDocumentUpload } from "./bulk-document-upload";
import { SOURCE_FIELD_DEFINITIONS } from "@/lib/document-extraction/rules";

const statusLabel: Record<string, string> = {
  pending: "Ожидает", extracted: "Распознано", needs_review: "Нужна проверка",
  confirmed: "Подтверждено", failed: "Не прочитано", superseded: "Устарело",
};
const fieldsByKind:Record<string,string[]>={
  invoice:["invoice_number","invoice_date","order_number","order_date","gross_weight_kg","net_weight_kg","pallet_count","incoterms"],
  transport_order:["contract_number","contract_date","carrier_name","driver_name","driver_phone","vehicle_plate","vehicle_make","trailer_plate","trailer_make","loading_address","unloading_address","temperature_setpoint","shipping_date"],
  vehicle_document:["vehicle_plate","vehicle_make","trailer_plate","trailer_make"],
  driver_document:["driver_name","driver_document","driver_phone"],
  waybill:["waybill_number","cmr_number","ttn_number","shipping_date","vehicle_plate","trailer_plate","driver_name","gross_weight_kg","net_weight_kg","pallet_count"],
  specification:["packing_list_number","order_number","gross_weight_kg","net_weight_kg","pallet_count"],
};
const fieldByKey=new Map(SOURCE_FIELD_DEFINITIONS.map(field=>[field.key,field]));
const sourceLabel: Record<string, string> = {
  invoice: "Инвойс", specification: "Спецификация", contract: "Договор",
  transport_order: "Договор-заявка", vehicle_document: "Документы автомобиля",
  driver_document: "Документы водителя", waybill: "Накладная", other: "Прочий источник",
};

export async function ShipmentSourceDocumentsPanel({ shipmentId }: { shipmentId: string }) {
  const supabase = await createClient();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "source_documents.review", "documents.create", "documents.view", "shipments.update"] as const);
  if (!permissions["documents.view"]) return null;
  const [{ data, error }, { data: types }] = await Promise.all([
    supabase.from("shipment_source_extractions")
      .select("id,document_id,source_kind,status,extracted_data,field_evidence,confirmed_data,conflicts,error_message,updated_at,document:documents(title,original_filename)")
      .eq("shipment_id", shipmentId).neq("status", "superseded").order("updated_at", { ascending: false }),
    permissions["documents.create"]
      ? supabase.from("document_types").select("id,code,name_ru,category").eq("is_active", true).order("sort_order")
      : Promise.resolve({ data: [] }),
  ]);
  const rows = (data ?? []) as Array<{
    id: string; source_kind: string; status: string; extracted_data: Record<string, unknown>;field_evidence:Record<string,{confidence?:number}>;confirmed_data:Record<string,unknown>;
    conflicts: unknown[]; error_message: string | null; document: { title: string; original_filename: string | null } | Array<{ title: string; original_filename: string | null }> | null;
  }>;
  const one = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] : value;
  return <section className="panel admin-section" id="source-documents">
    <div className="panel-heading"><div><p className="eyebrow">Шаг 1 · Исходные данные</p><h2>Загрузить комплект документов</h2></div><div className="topbar-actions">
      {permissions["documents.create"]&&<Link className="ghost button-link compact" href={`/documents?link=shipment:${shipmentId}#register`}>Открыть журнал</Link>}
      {permissions["source_documents.extract"]&&<form action={extractShipmentSourcesAction}><input type="hidden" name="shipment_id" value={shipmentId}/><button className="primary compact" type="submit">Распознать и сверить</button></form>}
    </div></div>
    <p className="form-help">Выберите сразу инвойс, договор-заявку, документы автомобиля, прицепа и водителя. После загрузки система автоматически определит типы, прочитает комплект и сопоставит найденные реквизиты.</p>
    {permissions["documents.create"]&&<BulkDocumentUpload types={(types??[]).map(type=>({id:type.id,code:type.code,name:type.name_ru,category:type.category}))} primaryLink={`shipment:${shipmentId}`} autoExtractShipmentId={shipmentId}/>}
    <div className="panel-heading source-results-heading"><div><p className="eyebrow">Шаг 2 · Проверка</p><h3>Результаты распознавания</h3></div></div>
    {error&&<div className="setup-notice">Примените миграцию <strong>202609273600_source_document_extraction.sql</strong>.</div>}
    {!error&&<div className="source-review-list">{rows.map(row=>{const document=one(row.document);const fields=Object.keys(row.extracted_data??{}).length;const conflicts=Array.isArray(row.conflicts)?row.conflicts.length:0;const keys=[...new Set([...(fieldsByKind[row.source_kind]??[]),...Object.keys(row.extracted_data??{})])].filter(key=>fieldByKey.has(key));return <details className="source-review-card" key={row.id} open={["extracted","needs_review"].includes(row.status)}><summary><div><strong>{document?.title??sourceLabel[row.source_kind]??"Исходный документ"}</strong><small>{sourceLabel[row.source_kind]??row.source_kind} · найдено полей: {fields}{conflicts?` · расхождений: ${conflicts}`:""}</small>{row.error_message&&<small>{row.error_message}</small>}</div><span className={`doc-badge doc-status-${row.status}`}>{statusLabel[row.status]??row.status}</span></summary>
      {conflicts>0&&<div className="login-error source-conflicts"><strong>Обнаружены расхождения между документами.</strong> Проверьте выделенные значения и оставьте правильные.</div>}
      {Array.isArray(row.extracted_data?.invoice_items)&&row.extracted_data.invoice_items.length>0&&<div className="table-wrap"><table className="data-table"><caption>Строки инвойса: подтверждаются вместе с документом и сверяются с позициями поставки</caption><thead><tr><th>№</th><th>Наименование</th><th>ТН ВЭД</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>{(row.extracted_data.invoice_items as Array<{line_number:number;product_name:string;hs_code:string;uom:string;quantity:number;unit_price:number;line_total:number}>).map(line=><tr key={line.line_number}><td>{line.line_number}</td><td>{line.product_name}</td><td>{line.hs_code}</td><td>{line.quantity} {line.uom}</td><td>{line.unit_price}</td><td>{line.line_total}</td></tr>)}</tbody></table></div>}
      {row.status!=="failed"&&<form action={confirmShipmentSourceAction} className="source-review-form"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={row.id}/><div className="source-field-grid">{keys.map(key=>{const field=fieldByKey.get(key)!;const current=row.status==="confirmed"?row.confirmed_data?.[key]:row.extracted_data?.[key];const confidence=row.field_evidence?.[key]?.confidence;return <label key={key}>{field.label}{confidence!==undefined&&<small>{Math.round(confidence*100)}% уверенности</small>}<input name={`field_${key}`} type={field.type} step={field.type==="number"?"0.001":undefined} min={field.type==="number"?"0":undefined} defaultValue={current===null||current===undefined?"":String(current)}/></label>;})}</div>{permissions["source_documents.review"]&&["extracted","needs_review","confirmed"].includes(row.status)&&<div className="source-review-actions">{permissions["shipments.update"]&&<label className="check-label"><input type="checkbox" name="apply_to_shipment" defaultChecked/> Записать применимые данные в поставку и автомобиль</label>}<button className="primary compact" type="submit">{row.status==="confirmed"?"Сохранить исправления":"Подтвердить данные"}</button></div>}</form>}
    </details>;})}{!rows.length&&<div className="empty-state">Загрузите исходные документы поставки — распознавание начнётся автоматически.</div>}</div>}
  </section>;
}
