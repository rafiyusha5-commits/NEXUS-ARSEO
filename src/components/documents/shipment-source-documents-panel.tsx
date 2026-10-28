import Link from "next/link";
import { SourceTransportContext } from "./source-transport-context";
import { ProcessingStatus } from "./processing-status";
import { loadProcessingClock } from "@/lib/documents/processing-clock";
import { CustomsEvidence } from "./customs-evidence";
import { SupplierEvidence } from "./supplier-evidence";
import { CustomsReviewForm } from "./customs-review-form";
import { CustomsRevisionForm } from "./customs-revision-form";
import { isPackingEvidence } from "@/lib/document-extraction/packing-evidence";
import type { buildShipmentDocumentReadiness } from "@/lib/templates/readiness";
import { confirmedCommoditySource, currentCommoditySource, isCommodityInvoice } from "@/lib/document-extraction/commodity-evidence";
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
import { DocumentQuantitiesForm, type QuantityFormItem, type QuantityHistoryRow } from "./document-quantities-form";
import { QUANTITY_SOURCE_KINDS, type DocumentLine } from "@/lib/shipments/document-quantities";

const statusLabel: Record<string, string> = {
  pending: "Ожидается результат", extracted: "Готово к проверке", needs_review: "Нужна проверка",
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

export async function ShipmentSourceDocumentsPanel({ shipmentId, notice, readiness }: { shipmentId: string; notice?: { kind: "error" | "success"; message: string }; readiness?: ReturnType<typeof buildShipmentDocumentReadiness> | null }) {
  const supabase = await createClient();
  const serverNow = await loadProcessingClock();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "source_documents.review", "documents.create", "documents.view", "shipments.update"] as const);
  if (!permissions["documents.view"]) return null;
  const [{ data, error, count: sourceCount }, { data: types }, { data: transportRows, error: transportsError, count: transportCount }, { data: itemRows, error: itemsError, count: itemCount }, { data: quantityHistory, error: historyError, count: historyCount }, { data: shipmentContext }, { data: contextHistory, error: contextError, count: contextCount }] = await Promise.all([
    supabase.from("shipment_source_extractions")
      .select("id,document_id,document_version_id,shipment_transport_id,source_kind,status,extracted_data,field_evidence,confirmed_data,conflicts,error_message,updated_at,reviewed_at,extraction_method,ocr_provider,ocr_provider_version,ocr_confidence,ocr_page_count,processing_ms,processing_started_at,ocr_lease_until,attempt_count,document:documents(title,original_filename,archived_at,status,current_version,versions:document_versions!document_versions_document_id_fkey(id,is_current,version_number),links:document_links(entity_type,entity_id,removed_at))", { count: "exact" })
      .eq("shipment_id", shipmentId).neq("status", "superseded").order("updated_at", { ascending: false }),
    permissions["documents.create"]
      ? supabase.from("document_types").select("id,code,name_ru,category").eq("is_active", true).order("sort_order")
      : Promise.resolve({ data: [] }),
    supabase.from("shipment_transports").select("id,sequence_no,status,vehicle_plate,driver_name", { count: "exact" }).eq("shipment_id", shipmentId).neq("status", "cancelled").order("sequence_no"),
    supabase.from("shipment_items").select("id,uom,shipment_transport_id,ordered_quantity,confirmed_quantity,shipped_quantity,product:products(internal_sku,name,hs_code)", { count: "exact" }).eq("shipment_id", shipmentId).order("created_at"),
    supabase.from("shipment_item_quantity_confirmations").select("shipment_item_id,extraction_id,field,quantity,confirmed_at", { count: "exact" }).eq("shipment_id", shipmentId).order("confirmed_at", { ascending: false }),
    supabase.from("shipments").select("shipment_number,type").eq("id", shipmentId).maybeSingle(),
    supabase.from("shipment_source_context_history").select("id,extraction_id,old_transport_id,new_transport_id,reason,changed_at,changed_by,extraction:shipment_source_extractions!inner(shipment_id)", { count: "exact" }).eq("extraction.shipment_id", shipmentId).order("changed_at", { ascending: false }),
  ]);
  const one = <T,>(value: T | T[] | null) => Array.isArray(value) ? value[0] : value;
  const quantityItems = ((itemRows ?? []) as Array<Omit<QuantityFormItem, "product"> & { product: QuantityFormItem["product"] | QuantityFormItem["product"][] }>)
    .map(item => ({ ...item, product: one(item.product) ?? null }));
  const canApplyQuantities = Boolean(permissions["source_documents.review"] && permissions["shipments.update"]);
  const vehicles = (transportRows ?? []) as Array<{ id: string; sequence_no: number; status: string; vehicle_plate: string | null; driver_name: string | null }>;
  const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
  const rows = (data ?? []) as Array<{
    id: string; document_id: string; document_version_id: string; shipment_transport_id: string | null; source_kind: string; status: string; extracted_data: Record<string, unknown>;field_evidence:Record<string,{confidence?:number}>;confirmed_data:Record<string,unknown>;
    extraction_method: string; ocr_provider: string | null; ocr_provider_version: string | null; ocr_confidence: number | null; ocr_page_count: number | null; processing_ms: number | null; attempt_count: number;
    updated_at: string; reviewed_at: string | null; processing_started_at: string | null; ocr_lease_until: string | null; conflicts: unknown[]; error_message: string | null; document: CommodityDocument | CommodityDocument[] | null;
  }>;
  type CommodityDocument = { title: string; original_filename: string | null; archived_at: string | null; status: string; current_version: number; versions: Array<{ id: string; is_current: boolean; version_number: number }>; links: Array<{ entity_type: string; entity_id: string; removed_at: string | null }> };
  const completeComparison = !itemsError && !error && !transportsError && transportCount === vehicles.length && !historyError && historyCount === (quantityHistory ?? []).length && itemCount === quantityItems.length && sourceCount === rows.length;
  const current = (row: typeof rows[number]) => completeComparison && currentCommoditySource(row, one(row.document), shipmentId, vehicles.map(vehicle => vehicle.id));
  const invoices = rows.filter(row => row.source_kind === "invoice" && confirmedCommoditySource(row, current(row))).map(row => row.extracted_data?.commodity_invoice).filter(isCommodityInvoice);
  const packing = rows.filter(row => row.source_kind === "specification" && confirmedCommoditySource(row, current(row))).map(row => row.extracted_data?.packing_evidence).filter(isPackingEvidence);
  const quantity = (value: unknown) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
  const shipmentCommodities = quantityItems.filter(item => !item.shipment_transport_id || vehicleById.has(item.shipment_transport_id)).map(item => ({
    sku: item.product?.internal_sku ?? null, unit: item.uom, hsCode: item.product?.hs_code ?? null,
    ordered: quantity(item.ordered_quantity), confirmed: quantity(item.confirmed_quantity), shipped: quantity(item.shipped_quantity),
  }));
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
    {!error&&!completeComparison&&<p className="login-error">Не удалось получить полный список источников или позиций поставки. Сверка и подтверждение временно недоступны.</p>}
    {!error&&<div className="source-review-list">{rows.map(row=>{const document=one(row.document);const fields=Object.keys(row.extracted_data??{}).length;const conflicts=Array.isArray(row.conflicts)?row.conflicts.length:0;const keys=[...new Set([...(fieldsByKind[row.source_kind]??[]),...Object.keys(row.extracted_data??{})])].filter(key=>fieldByKey.has(key));const sourceCurrent=current(row);const quantityDocument=row.status==="confirmed"&&QUANTITY_SOURCE_KINDS.has(row.source_kind);const quantitiesWritten=(quantityHistory??[]).some(entry=>entry.extraction_id===row.id);return <details className="source-review-card" key={row.id} open={["pending","extracted","needs_review"].includes(row.status)||(quantityDocument&&canApplyQuantities&&!quantitiesWritten)}><summary><div><strong>{document?.title??sourceLabel[row.source_kind]??"Исходный документ"}</strong><small>{sourceLabel[row.source_kind]??row.source_kind} · найдено полей: {fields}{conflicts?` · расхождений: ${conflicts}`:""}{quantityDocument?(quantitiesWritten?" · количества записаны":" · количества не записаны"):""}</small>{row.extraction_method==="ocr"&&<small>Распознано по изображению (OCR) · {row.ocr_provider} {row.ocr_provider_version}{row.ocr_page_count?` · стр.: ${row.ocr_page_count}`:""}{row.ocr_confidence!==null?` · уверенность ${Math.round(row.ocr_confidence*100)}%`:""}{row.processing_ms!==null?` · ${(row.processing_ms/1000).toLocaleString("ru-RU",{maximumFractionDigits:1})} с`:""}</small>}{row.error_message&&<small>{row.status==="confirmed"?"До ручной проверки OCR сообщал: ":""}{row.error_message}</small>}</div><span className={`doc-badge doc-status-${row.status}`}>{row.status==="pending"?"Состояние обработки — ниже":statusLabel[row.status]??row.status}</span></summary>
      {!sourceCurrent&&<p className="login-error">Актуальность или полнота источника не подтверждена. Обновите страницу и повторите распознавание; подтверждение и запись количеств отключены.</p>}
      {vehicles.length>0&&row.status!=="superseded"&&<div className="source-vehicle-binding">
        <span>Относится к: <strong>{row.shipment_transport_id&&vehicleById.get(row.shipment_transport_id)?`автомобилю ${describeTransport(vehicleById.get(row.shipment_transport_id)!)}`:"ко всей поставке"}</strong></span>
        <SourceTransportContext shipmentId={shipmentId} extractionId={row.id}
          shipmentLabel={`${({ import: "Импорт", export: "Экспорт", domestic_transfer: "Перемещение" } as Record<string,string>)[shipmentContext?.type ?? ""] ?? "Операция"} · ${shipmentContext?.shipment_number ?? "текущая поставка"}`}
          transportId={row.shipment_transport_id} vehicles={vehicles.map(v=>({id:v.id,label:`Автомобиль ${describeTransport(v)}`}))}
          editable={sourceCurrent&&Boolean(permissions["source_documents.extract"])&&!["confirmed","pending","superseded"].includes(row.status)}
          history={contextError||contextCount!==(contextHistory?.length??0)?[]:(contextHistory??[]).filter(h=>h.extraction_id===row.id)}
          historyUnavailable={!!contextError||contextCount!==(contextHistory?.length??0)} action={assignSourceTransportAction}/>
        {vehicles.length>1&&!row.shipment_transport_id&&row.status!=="confirmed"&&VEHICLE_SCOPED_FIELDS.some(field=>row.extracted_data?.[field]!==undefined&&row.extracted_data?.[field]!==null&&row.extracted_data?.[field]!=="")&&<small className="login-error">В поставке несколько автомобилей: выберите, к какому относится документ, иначе данные водителя и машины не будут записаны.</small>}
      </div>}
      {row.status==="pending"&&<ProcessingStatus serverNow={serverNow} receipts={[{id:row.id,kind:"ocr",state:"running",stage:"recognizing",started_at:row.processing_started_at??row.updated_at,updated_at:row.updated_at,lease_until:row.ocr_lease_until??row.updated_at,finished_at:null,error_code:null}]}/>}
      {row.extraction_method==="ocr"&&["extracted","needs_review"].includes(row.status)&&<div className="setup-notice">Текст получен распознаванием изображения и может содержать ошибки. Сверьте каждое значение с оригиналом: в поставку попадает только то, что вы подтвердите.</div>}
      {row.extraction_method==="ocr"&&permissions["source_documents.extract"]&&(row.status==="failed"||(["extracted","needs_review","confirmed"].includes(row.status)&&permissions["source_documents.review"]))&&<form action={retryShipmentSourceOcrAction} className="source-review-actions"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="document_id" value={row.document_id}/><PendingSubmitButton className="ghost compact" pendingText="Распознаём… подождите">{row.status==="failed"?`Повторить распознавание${row.attempt_count>0?` (попыток: ${row.attempt_count})`:""}`:row.status==="confirmed"?"Отменить подтверждение и распознать заново":"Сбросить результат и распознать заново"}</PendingSubmitButton></form>}
      {conflicts>0&&<div className="login-error source-conflicts"><strong>Обнаружены расхождения между документами.</strong> Проверьте выделенные значения и оставьте правильные.</div>}
      {Array.isArray(row.extracted_data?.invoice_items)&&row.extracted_data.invoice_items.length>0&&<div className="table-wrap"><table className="data-table"><caption>Строки инвойса: подтверждаются вместе с документом и сверяются с позициями поставки</caption><thead><tr><th>№</th><th>Наименование</th><th>ТН ВЭД</th><th>Кол-во</th><th>Цена</th><th>Сумма</th></tr></thead><tbody>{(row.extracted_data.invoice_items as Array<{line_number:number;product_name:string;hs_code:string;uom:string;quantity:number;unit_price:number;line_total:number}>).map(line=><tr key={line.line_number}><td>{line.line_number}</td><td>{line.product_name}</td><td>{line.hs_code}</td><td>{line.quantity} {line.uom}</td><td>{line.unit_price}</td><td>{line.line_total}</td></tr>)}</tbody></table></div>}
      <SupplierEvidence invoice={row.extracted_data?.commodity_invoice} packing={row.extracted_data?.packing_evidence} current={sourceCurrent}/>
      {Boolean(row.extracted_data?.customs_record)&&<CustomsEvidence value={row.extracted_data.customs_record} invoices={invoices} packing={packing} readiness={readiness} shipment={shipmentCommodities} current={current(row)} reviewed={row.status==="confirmed"&&Boolean(row.reviewed_at)}/>}
      {sourceCurrent&&permissions["source_documents.review"]&&Boolean(row.extracted_data?.customs_record)&&row.extracted_data.customs_record!==null&&typeof row.extracted_data.customs_record==="object"&&"kind" in row.extracted_data.customs_record&&row.extracted_data.customs_record.kind==="declaration"&&<>
        <Link className="ghost button-link compact" href={`/documents/${row.document_id}/download?version=${row.document_version_id}`}>Открыть оригинал декларации</Link>
        <CustomsReviewForm shipmentId={shipmentId} extractionId={row.id} versionId={row.document_version_id} record={row.extracted_data.customs_record} note={row.confirmed_data?.customs_review_note} reviewedAt={row.status==="confirmed"?row.reviewed_at:null}/>
        {row.extraction_method==="text_layer"&&permissions["source_documents.extract"]&&<CustomsRevisionForm shipmentId={shipmentId} documentId={row.document_id} extractionId={row.id} versionId={row.document_version_id} updatedAt={row.updated_at}/>}
      </>}
      {sourceCurrent&&row.source_kind==="invoice"&&row.extraction_method==="text_layer"&&row.status==="confirmed"&&permissions["source_documents.extract"]&&permissions["source_documents.review"]&&<form action={retryShipmentSourceOcrAction} className="source-review-actions"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="document_id" value={row.document_id}/><PendingSubmitButton className="ghost compact" pendingText="Обновляем строки…">Обновить строки инвойса, сохранив подтверждения</PendingSubmitButton></form>}
      {isCommodityInvoice(row.extracted_data?.commodity_invoice)&&<p>Для сверки с декларацией прочитано строк инвойса: {row.extracted_data.commodity_invoice.items.length}. {row.extracted_data.commodity_invoice.warnings.join(" ")} Эти строки не записываются автоматически в количества поставки. {row.status==="confirmed"&&"Ручные подтверждения реквизитов сохранены; товарные строки являются отдельным результатом чтения."}</p>}
      {sourceCurrent&&keys.length>0&&!["failed","pending"].includes(row.status)&&<form action={confirmShipmentSourceAction} className="source-review-form"><input type="hidden" name="shipment_id" value={shipmentId}/><input type="hidden" name="extraction_id" value={row.id}/><div className="source-field-grid">{keys.map(key=>{const field=fieldByKey.get(key)!;const current=row.status==="confirmed"?row.confirmed_data?.[key]:row.extracted_data?.[key];const confidence=row.status==="confirmed"?undefined:row.field_evidence?.[key]?.confidence;return <label key={key} className={confidence!==undefined&&confidence<LOW_CONFIDENCE?"low-confidence":undefined}>{field.label}{confidence!==undefined&&<small>{Math.round(confidence*100)}% уверенности{confidence<LOW_CONFIDENCE?" · проверьте по оригиналу":""}</small>}<input name={`field_${key}`} type={field.type} step={field.type==="number"?"0.001":undefined} min={field.type==="number"?"0":undefined} defaultValue={current===null||current===undefined?"":String(current)}/></label>;})}</div>{permissions["source_documents.review"]&&["extracted","needs_review","confirmed"].includes(row.status)&&<div className="source-review-actions">{permissions["shipments.update"]&&<label className="check-label"><input type="checkbox" name="apply_to_shipment"/> Записать применимые данные в поставку и автомобиль</label>}<button className="primary compact" type="submit">{row.status==="confirmed"?"Сохранить исправления":"Подтвердить данные"}</button></div>}</form>}
      {quantityDocument&&<DocumentQuantitiesForm shipmentId={shipmentId} extractionId={row.id} sourceKind={row.source_kind} transportId={row.shipment_transport_id} items={quantityItems} lines={Array.isArray(row.extracted_data?.invoice_items)?row.extracted_data.invoice_items as DocumentLine[]:[]} history={(quantityHistory??[]) as QuantityHistoryRow[]} canApply={canApplyQuantities&&sourceCurrent}/>}
    </details>;})}{!rows.length&&<div className="empty-state">Загрузите исходные документы поставки — распознавание начнётся автоматически.</div>}</div>}
  </section>;
}
