"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { DOCUMENT_BUCKET } from "@/lib/documents/files";
import { conflictsAcrossDocuments, extractShipmentFields, EXTRACTION_VERSION } from "@/lib/document-extraction/rules";
import { extractDocumentText } from "@/lib/document-extraction/text";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const one = <T,>(value: T | T[] | null | undefined) => Array.isArray(value) ? value[0] : value ?? undefined;
const value = (formData: FormData, key: string) => {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
};
const back = (shipmentId: string, kind: "error" | "success", message: string) =>
  `/shipments/${shipmentId}?${kind}=${encodeURIComponent(message)}#source-documents`;

function sourceKind(code: string) {
  if (["invoice", "specification", "waybill", "transport_order", "vehicle_document", "driver_document"].includes(code)) return code;
  if (["supplier_contract", "customer_contract"].includes(code)) return "contract";
  return "other";
}

export async function extractShipmentSourcesAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  if (!UUID.test(shipmentId)) redirect("/shipments?error=Некорректная поставка");
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "documents.view", "shipments.view"] as const);
  if (!permissions["source_documents.extract"] || !permissions["documents.view"] || !permissions["shipments.view"])
    redirect(back(shipmentId, "error", "Недостаточно прав для распознавания исходных документов"));

  const { data: transports } = await supabase.from("shipment_transports").select("id").eq("shipment_id", shipmentId);
  const transportIds = (transports ?? []).map(row => row.id as string);
  const linkFilter = transportIds.length
    ? `and(entity_type.eq.shipment,entity_id.eq.${shipmentId}),and(entity_type.eq.shipment_transport,entity_id.in.(${transportIds.join(",")}))`
    : `and(entity_type.eq.shipment,entity_id.eq.${shipmentId})`;
  const { data: links, error: linkError } = await supabase.from("document_links").select("document_id").is("removed_at", null).or(linkFilter);
  if (linkError) redirect(back(shipmentId, "error", `Не удалось прочитать документы: ${linkError.message}`));
  const documentIds = [...new Set((links ?? []).map(row => row.document_id as string))];
  if (!documentIds.length) redirect(back(shipmentId, "error", "Сначала загрузите и привяжите исходные документы к поставке"));

  const [{ data: documents, error: documentsError }, { data: generated }] = await Promise.all([
    supabase.from("documents").select("id,title,archived_at,type:document_types(code),versions:document_versions(id,storage_path,mime_type,is_current,version_number)").in("id", documentIds),
    supabase.from("document_generations").select("document_id").in("document_id", documentIds),
  ]);
  if (documentsError) redirect(back(shipmentId, "error", documentsError.message));
  const generatedIds = new Set((generated ?? []).map(row => row.document_id as string));
  const sourceDocuments = (documents ?? []).filter(document => !document.archived_at && !generatedIds.has(document.id));
  if (!sourceDocuments.length) redirect(back(shipmentId, "error", "В поставке нет исходных документов для распознавания"));

  const prepared: Array<{
    documentId: string; versionId: string; sourceKind: string; result: ReturnType<typeof extractShipmentFields>;
    error: string | null;
  }> = [];
  for (const document of sourceDocuments) {
    const version = (document.versions as Array<{ id: string; storage_path: string; mime_type: string; is_current: boolean }> | null)?.find(item => item.is_current);
    const code = one(document.type as { code: string } | Array<{ code: string }> | null)?.code ?? "other";
    if (!version) {
      prepared.push({ documentId: document.id, versionId: "", sourceKind: sourceKind(code), result: { data: {}, evidence: {}, conflicts: [] }, error: "У документа нет текущей версии" });
      continue;
    }
    try {
      const { data: file, error: downloadError } = await supabase.storage.from(DOCUMENT_BUCKET).download(version.storage_path);
      if (downloadError || !file) throw new Error(downloadError?.message || "Файл не найден");
      const text = await extractDocumentText(new Uint8Array(await file.arrayBuffer()), version.mime_type);
      const result = extractShipmentFields(text);
      prepared.push({ documentId: document.id, versionId: version.id, sourceKind: sourceKind(code), result, error: Object.keys(result.data).length ? null : "Реквизиты не распознаны автоматически" });
    } catch (error) {
      prepared.push({ documentId: document.id, versionId: version.id, sourceKind: sourceKind(code), result: { data: {}, evidence: {}, conflicts: [] }, error: error instanceof Error ? error.message : "Не удалось прочитать файл" });
    }
  }

  const successful = prepared.filter(item => !item.error).map(item => ({ documentId: item.documentId, result: item.result }));
  const commonConflicts = conflictsAcrossDocuments(successful);
  let confirmed = 0, review = 0, failed = 0;
  for (const item of prepared) {
    if (!item.versionId) { failed++; continue; }
    const conflicts = commonConflicts.filter(conflict => conflict.documents?.includes(item.documentId));
    const status = item.error ? "failed" : conflicts.length ? "needs_review" : "confirmed";
    const { error } = await supabase.rpc("upsert_shipment_source_extraction", {
      p_shipment_id: shipmentId,
      p_document_id: item.documentId,
      p_document_version_id: item.versionId,
      p_source_kind: item.sourceKind,
      p_status: status,
      p_extracted_data: item.result.data,
      p_field_evidence: item.result.evidence,
      p_conflicts: conflicts,
      p_error_message: item.error,
      p_extractor_version: EXTRACTION_VERSION,
    });
    if (error) failed++;
    else if (status === "confirmed") confirmed++;
    else if (status === "needs_review") review++;
    else failed++;
  }
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, failed || review ? "error" : "success", `Распознано автоматически: ${confirmed}; требуется проверка: ${review}; не прочитано: ${failed}`));
}

export async function confirmShipmentSourceAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const extractionId = value(formData, "extraction_id");
  if (!UUID.test(shipmentId) || !UUID.test(extractionId)) redirect("/shipments?error=Некорректные данные");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("confirm_shipment_source_extraction", { p_extraction_id: extractionId });
  if (error) redirect(back(shipmentId, "error", error.message));
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", "Распознанные данные подтверждены и будут использованы при формировании документов"));
}
