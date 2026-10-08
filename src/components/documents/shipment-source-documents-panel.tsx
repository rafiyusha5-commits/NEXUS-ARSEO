import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { loadPermissions } from "@/lib/permissions";
import { assignSourceTransportAction, confirmShipmentSourceAction, extractShipmentSourcesAction, retryShipmentSourceOcrAction } from "@/app/shipments/source-document-actions";
import { describeTransport } from "@/lib/shipments/transport-form";
import { VEHICLE_SCOPED_FIELDS } from "@/lib/document-extraction/rules";
import { describeOcrConfig, loadOcrConfig } from "@/lib/ocr/config";
import { LOW_CONFIDENCE } from "@/lib/ocr/recognize";
import { BulkDocumentUpload } from "./bulk-document-upload";
import { SOURCE_FIELD_DEFINITIONS } from "@/lib/document-extraction/rules";
import { PendingSubmitButton } from "@/components/pending-submit-button";

const statusLabel: Record<string, string> = {
  pending: "Обрабатывается", extracted: "Готово к проверке", needs_review: "Нужна проверка",
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

export async function ShipmentSourceDocumentsPanel({ shipmentId, notice }: { shipmentId: string; notice?: { kind: "error" | "success"; message: string } }) {
  const supabase = await createClient();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "source_documents.review", "documents.create", "documents.view", "shipments.update"] as const);
  if (!permissions["documents.view"]) return null;
  const [{ data, error }, { data: types }, { data: transportRows }] = await Promise.all([
    supabase.from("shipment_source_extractions")
      .select("id,document_id,shipment_transport_id,source_kind,status,extracted_data,field_evidence,confirmed_data,conflicts,error_message,updated_at,extraction_method,ocr_provider,ocr_provider_version,ocr_confidence,ocr_page_count,processing_ms,attempt_count,document:documents(title,original_filename)")
      .eq("shipment_id", shipmentId).neq("status", "superseded").order("updated_at", { ascending: false }),
    permissions["documents.create"]
      ? supabase.from("document_types").select("id,code,name_ru,category").eq("is_active", true).order("sort_order")
      : Promise.resolve({ data: [] }),
    supabase.from("shipment_transports").select("id,sequence_no,status,vehicle_plate,driver_name").eq("shipment_id", shipmentId).neq("status", "cancelled").order("sequence_no"),
  ]);
  const vehicles = (transportRows ?? []) as Array<{ id: string; sequence_no: number; status: string; vehicle_plate: string | null; driver_name: string | null }>;
  const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const rows = (data ?? []) as Array<{
    id: string; document_id: string; shipment_transport_id: string | null; source_kind: string; status: string; extracted_data: Record<string, unknown>;field_evidence:Record<string,{confidence?:number}>;confirmed_data:Record<string,unknown>;
    extraction_method: string; ocr_provider: string | null; ocr_provider_version: string | null; ocr_confidence: number | null; ocr_page_count: number | null; processing_ms: number | null; attempt_count: number;
    conflicts: unknown[]; error_message: string | null; document: { title: string; original_filename: string | null } | Array<{ title: string; original_filename: string | null }> | null;
  }>;
  const one = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] : value;
  const ocr = describeOcrConfig(loadOcrConfig());
  return <section className="panel admin-section" id="source-documents">
    <div className="panel-heading"><div><p className="eyebrow">Шаг 1 · Исходные данные</p><h2>Загрузить комплект документов</h2></div><div className="topbar-actions">
      {permissions["documents.create"]&&<Link className="ghost button-link compact" href={`/documents?link=shipment:${shipmentId}#register`}>Открыть журнал</Link>}
      {permissions["source_documents.extract"]&&<form action={extractShipmentSourcesAction}><input type="hidden" name="shipment_id" value={shipmentId}/><PendingSubmitButton className="primary compact" pendingText="Распознаём…">Распознать и сверить</PendingSubmitButton></form>}
    </div></div>
    {notice?.kind==="error"&&<div className="login-error admin-message" role="status">{notice.message}</div>}
    {notice?.kind==="success"&&<div className="login-success admin-message" role="status">{notice.message}</div>}
    <p className="form-help">Выберите сразу инвойс, договор-заявку, документы автомобиля, прицепа и водителя. После загрузки система автоматически определит типы, прочитает комплект и сопоставит найденные реквизиты. {ocr.enabled?"Сканы и фотографии читаются распознаванием текста (OCR); результат всегда проверяет сотрудник.":"Сканы и фотографии пока не читаются: OCR не настроен администратором."}</p>
    {permissions["documents.create"]&&<BulkDocumentUpload types={(types??[]).map(type=>({id:type.id,code:type.code,name:type.name_ru,category:type.category}))} primaryLink={`shipment:${shipmentId}`} autoExtractShipmentId={shipmentId} transports={vehicles.map(vehicle=>({id:vehicle.id,label:describeTransport(vehicle)}))}/>}
    <div className="panel-heading source-results-heading"><div><p className="eyebrow">Шаг 2 · Проверка</p><h3>Результаты распознавания</h3></div></div>
    {error&&<div className="setup-notice">Примените миграцию <strong>202609274900_source_document_ocr.sql</strong>.</div>}
    {!error&&<div className="source-review-list">{rows.map(row=>{const document=one(row.document);const fields=Object.keys(row.extracted_data??{}).length;const conflicts=Array.isArray(row.conflicts)?row.conflicts.length:0;const keys=[...new Set([...(fieldsByKind[row.source_kind]??[]),...Object.keys(row.extracted_data??{})])].filter(key=>fieldByKey.has(key));return <details className="source-review-card" key={row.id} open={["pending","extracted","needs_review"].includes(row.status)}><summary><div><strong>{document?.title??sourceLabel[row.source_kind]??"Исходный документ"}</strong><small>{sourceLabel[row.source_kind]??row.source_kind} · найдено полей: {fields}{conflicts?` · расхождений: ${conflicts}`:""}</small>{row.extraction_method==="ocr"&&<small>Распознано по изображению (OCR) · {row.ocr_provider} {row.ocr_provider_version}{row.ocr_page_count?` · стр.: ${row.ocr_page_count}`:""}{row.ocr_confidence!==null?` · уверенность ${Math.round(row.ocr_confidence*100)}%`:""}{row.processing_ms!==null?` · ${(row.processing_ms/1000).toLocaleString("ru-RU",{maximumFractionDigits:1})} с`:""}</small>}{row.error_message&&<small>{row.error_message}</small>}</div><span className={`doc-badge doc-status-${row.status}`}>{statusLabel[row.status]??row.status}</span></summary>
      {vehicles.length>0&&row.status!=="superseded"&&<div className="source-vehicle-binding">
        <span>Относится к: <strong>{row.shipment_transport_id&&vehicleById.get(row.shipment_transport_id)?`автомобилю ${describeTransport(vehicleById.get(row.shipment_transport_id)!)}`:"ко всей поставке"}</strong></span>
        {permissions["source_documents.extract"]&&row.status!=="confirmed"&&<form action={assignSourceTransportAction} className="inline-item-form"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={row.id}/><select name="transport_id" defaultValue={row.shipment_transport_id??""} aria-label="Автомобиль документа"><option value="">Вся поставка</option>{vehicles.map(vehicle=><option key={vehicle.id} value={vehicle.id}>Автомобиль {describeTransport(vehicle)}</option>)}</select><button className="ghost compact" type="submit">Привязать</button></form>}
        {vehicles.length>1&&!row.shipment_transport_id&&row.status!=="confirmed"&&VEHICLE_SCOPED_FIELDS.some(field=>row.extracted_data?.[field]!==undefined&&row.extracted_data?.[field]!==null&&row.extracted_data?.[field]!=="")&&<small className="login-error">В поставке несколько автомобилей: выберите, к какому относится документ, иначе данные водителя и машины не будут записаны.</small>}
      </div>}
      {row.status==="pending"&&<div className="setup-notice">Документ обрабатывается. Если статус не меняется несколько минут, запустите «Распознать и сверить» ещё раз.</div>}
      {row.extraction_method==="ocr"&&["extracted","needs_review"].includes(row.status)&&<div className="setup-notice">Текст получен распознаванием изображения и может содержать ошибки. Сверьте каждое значение с оригиналом: в поставку попадает только то, что вы подтвердите.</div>}
      {row.extraction_method==="ocr"&&permissions["source_documents.extract"]&&(row.status==="failed"||(["extracted","needs_review","confirmed"].includes(row.status)&&permissions["source_documents.review"]))&&<form action={retryShipmentSourceOcrAction} className="source-review-actions"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="document_id" value={row.document_id}/><PendingSubmitButton className="ghost compact" pendingText="Распознаём… подождите">{row.status==="failed"?`Повторить распознавание${row.attempt_count>0?` (попыток: ${row.attempt_count})`:""}`:row.status==="confirmed"?"Отменить подтверждение и распознать заново":"Сбросить результат и распознать заново"}</PendingSubmitButton></form>}
      {conflicts>0&&<div className="login-error source-conflicts"><strong>Обнаружены расхождения между документами.</strong> Проверьте выделенные значения и оставьте правильные.</div>}
      {Array.isArray(row.extracted_data?.invoice_items)&&row.extracted_data.invoice_items.length>0&&<div className="table-wrap"><table className="data-table"><caption>Строки инвойса: подтверждаются вместе с документом и сверяются с позициями поставки</caption><thead><tr><th>№</th><th>Наименование</th><th>ТН ВЭД</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>{(row.extracted_data.invoice_items as Array<{line_number:number;product_name:string;hs_code:string;uom:string;quantity:number;unit_price:number;line_total:number}>).map(line=><tr key={line.line_number}><td>{line.line_number}</td><td>{line.product_name}</td><td>{line.hs_code}</td><td>{line.quantity} {line.uom}</td><td>{line.unit_price}</td><td>{line.line_total}</td></tr>)}</tbody></table></div>}
      {!["failed","pending"].includes(row.status)&&<form action={confirmShipmentSourceAction} className="source-review-form"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={row.id}/><div className="source-field-grid">{keys.map(key=>{const field=fieldByKey.get(key)!;const current=row.status==="confirmed"?row.confirmed_data?.[key]:row.extracted_data?.[key];const confidence=row.field_evidence?.[key]?.confidence;return <label key={key} className={confidence!==undefined&&confidence<LOW_CONFIDENCE?"low-confidence":undefined}>{field.label}{confidence!==undefined&&<small>{Math.round(confidence*100)}% уверенности{confidence<LOW_CONFIDENCE?" · проверьте по оригиналу":""}</small>}<input name={`field_${key}`} type={field.type} step={field.type==="number"?"0.001":undefined} min={field.type==="number"?"0":undefined} defaultValue={current===null||current===undefined?"":String(current)}/></label>;})}</div>{permissions["source_documents.review"]&&["extracted","needs_review","confirmed"].includes(row.status)&&<div className="source-review-actions">{permissions["shipments.update"]&&<label className="check-label"><input type="checkbox" name="apply_to_shipment" defaultChecked/> Записать применимые данные в поставку и автомобиль</label>}<button className="primary compact" type="submit">{row.status==="confirmed"?"Сохранить исправления":"Подтвердить данные"}</button></div>}</form>}
    </details>;})}{!rows.length&&<div className="empty-state">Загрузите исходные документы поставки — распознавание начнётся автоматически.</div>}</div>}
  </section>;
}
