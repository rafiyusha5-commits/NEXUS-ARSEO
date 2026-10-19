"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { refreshLogistAfterChange } from "@/lib/logist/run";
import { loadPermissions } from "@/lib/permissions";
import { extractShipmentSources } from "@/lib/document-extraction/shipment-service";
import { sanitizeConfirmedSourceData, SOURCE_FIELD_DEFINITIONS } from "@/lib/document-extraction/rules";
import { publicErrorMessage, ruleViolationMessage } from "@/lib/errors/public-message";
import { describeExtractionSummary } from "@/lib/document-extraction/summary";
import { runDocumentCheckAfterRecognition } from "@/lib/document-check/run";
import { parseQuantityLines } from "@/lib/shipments/document-quantities";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value = (formData: FormData, key: string) => {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
};
const back = (shipmentId: string, kind: "error" | "success", message: string) =>
  `/shipments/${shipmentId}?tab=documents&source_${kind}=${encodeURIComponent(message)}#source-documents`;

export async function extractShipmentSourcesAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  if (!UUID.test(shipmentId)) redirect("/shipments?error=Некорректная поставка");
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "documents.view", "shipments.view"] as const);
  if (!permissions["source_documents.extract"] || !permissions["documents.view"] || !permissions["shipments.view"])
    redirect(back(shipmentId, "error", "Недостаточно прав для распознавания исходных документов"));

  let summary;
  try { summary = await extractShipmentSources(supabase, shipmentId); }
  catch (error) {
    console.error("[source-document-extraction]", error);
    redirect(back(shipmentId, "error", publicErrorMessage(error,"Не удалось распознать документы.")));
  }
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, summary.failed || summary.review ? "error" : "success", describeExtractionSummary(summary)));
}

// Another attempt for one unread document. Going beyond the attempt limit is a reviewer's decision (the database checks it).
export async function retryShipmentSourceOcrAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const documentId = value(formData, "document_id");
  if (!UUID.test(shipmentId) || !UUID.test(documentId)) redirect("/shipments?error=Некорректные данные");
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "source_documents.review", "documents.view", "shipments.view"] as const);
  if (!permissions["source_documents.extract"] || !permissions["documents.view"] || !permissions["shipments.view"])
    redirect(back(shipmentId, "error", "Недостаточно прав для распознавания исходных документов"));
  let summary;
  try { summary = await extractShipmentSources(supabase, shipmentId, { documentId, force: permissions["source_documents.review"] }); }
  catch (error) { redirect(back(shipmentId, "error", publicErrorMessage(error, "Не удалось повторить распознавание."))); }
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, summary.failed ? "error" : "success", describeExtractionSummary(summary)));
}

export async function confirmShipmentSourceAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const extractionId = value(formData, "extraction_id");
  if (!UUID.test(shipmentId) || !UUID.test(extractionId)) redirect("/shipments?error=Некорректные данные");
  const raw=Object.fromEntries(SOURCE_FIELD_DEFINITIONS.map(field=>[field.key,value(formData,`field_${field.key}`)]));
  const confirmedData=sanitizeConfirmedSourceData(raw);
  if(!Object.keys(confirmedData).length)redirect(back(shipmentId,"error","Укажите хотя бы одно подтверждённое поле"));
  const applyToShipment=value(formData,"apply_to_shipment")==="on";
  const { supabase } = await requireUser();
  const permissions=await loadPermissions(supabase,["source_documents.review","shipments.update"] as const);
  if(!permissions["source_documents.review"])redirect(back(shipmentId,"error","Недостаточно прав для подтверждения данных"));
  const { error } = await supabase.rpc("review_shipment_source_extraction", { p_extraction_id: extractionId,p_confirmed_data:confirmedData,p_apply_to_shipment:applyToShipment&&permissions["shipments.update"] });
  if (error) redirect(back(shipmentId, "error", ruleViolationMessage(error,"Не удалось подтвердить распознанные данные.")));
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  await refreshLogistAfterChange(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", "Распознанные данные подтверждены и будут использованы при формировании документов"));
}

export async function reviseShipmentCustomsAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id"), documentId = value(formData, "document_id");
  const extractionId = value(formData, "extraction_id"), versionId = value(formData, "document_version_id"), requestId = value(formData, "request_id");
  const updatedAt = value(formData, "expected_updated_at"), reason = value(formData, "reason");
  if (![shipmentId, documentId, extractionId, versionId, requestId].every(id => UUID.test(id))) redirect("/shipments?error=Некорректные данные");
  if (value(formData, "checked") !== "on" || reason.length < 10 || reason.length > 2000 || !Number.isFinite(Date.parse(updatedAt)))
    redirect(back(shipmentId, "error", "Подтвердите новую редакцию и укажите причину (10–2000 символов)"));
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "source_documents.review", "documents.view", "shipments.view"] as const);
  if (!Object.values(permissions).every(Boolean)) redirect(back(shipmentId, "error", "Недостаточно прав для новой редакции"));
  // Bind the selected file to the extraction before reading; the RPC repeats version/link checks under locks.
  const { data: source, error: sourceError } = await supabase.from("shipment_source_extractions").select("document_id")
    .eq("id", extractionId).eq("shipment_id", shipmentId).single();
  if (sourceError || source?.document_id !== documentId) redirect(back(shipmentId, "error", "Источник изменился. Обновите страницу"));
  try { await extractShipmentSources(supabase, shipmentId, { documentId, customsRevision: { extractionId, versionId, updatedAt, requestId, reason } }); }
  catch (error) { redirect(back(shipmentId, "error", ruleViolationMessage(error, "Не удалось создать новую редакцию."))); }
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", "Создана новая редакция декларации. Сверьте и подтвердите её заново. Прежняя сверка сохранена в истории, ручные реквизиты сохранены; поставка, склад и финансы не изменены"));
}

// Acknowledge the exact declaration shown on the page. No editable quantities or finance values.
export async function confirmShipmentCustomsAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const extractionId = value(formData, "extraction_id");
  const versionId = value(formData, "document_version_id");
  if (![shipmentId, extractionId, versionId].every(id => UUID.test(id))) redirect("/shipments?error=Некорректные данные");
  if (value(formData, "checked") !== "on") redirect(back(shipmentId, "error", "Подтвердите сверку с оригиналом декларации"));
  const note = value(formData, "review_note");
  if (note.length < 10 || note.length > 2000) redirect(back(shipmentId, "error", "Опишите результат сверки (10–2000 символов)"));
  let record: unknown;
  try { record = JSON.parse(value(formData, "expected_record")); }
  catch { redirect(back(shipmentId, "error", "Данные страницы устарели. Обновите страницу")); }
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("review_shipment_customs_evidence", {
    p_shipment_id: shipmentId, p_extraction_id: extractionId, p_document_version_id: versionId,
    p_expected_record: record, p_review_note: note,
  });
  if (error) redirect(back(shipmentId, "error", ruleViolationMessage(error, "Не удалось сохранить сверку декларации.")));
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", "Сверка декларации с оригиналом подтверждена. Расхождения с заказом сохранены; склад и финансы не изменены"));
}

// Binds an unconfirmed document or OCR proposal to one vehicle (or back to the whole shipment). Nothing is guessed.
export async function assignSourceTransportAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const extractionId = value(formData, "extraction_id");
  const transportId = value(formData, "transport_id");
  if (!UUID.test(shipmentId) || !UUID.test(extractionId) || (transportId && !UUID.test(transportId))) redirect("/shipments?error=Некорректные данные");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("assign_source_extraction_transport", { p_extraction_id: extractionId, p_transport_id: transportId || null });
  if (error) redirect(back(shipmentId, "error", ruleViolationMessage(error, "Не удалось привязать документ к автомобилю.")));
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  await refreshLogistAfterChange(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", transportId ? "Документ привязан к автомобилю" : "Документ относится ко всей поставке"));
}

// Confirmed or shipped quantities from a confirmed invoice, packing list or waybill. The employee checks every
// value against the original; only filled inputs are written, the database keeps the history.
export async function applyDocumentQuantitiesAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const extractionId = value(formData, "extraction_id");
  if (!UUID.test(shipmentId) || !UUID.test(extractionId)) redirect("/shipments?error=Некорректные данные");
  const target = value(formData, "target");
  const targets = target === "both" ? ["confirmed", "shipped"] : [target];
  if (!targets.every(item => item === "confirmed" || item === "shipped")) redirect(back(shipmentId, "error", "Выберите, какое количество заполнить"));
  if (value(formData, "checked") !== "on") redirect(back(shipmentId, "error", "Подтвердите, что количества сверены с оригиналом документа"));
  let lines: ReturnType<typeof parseQuantityLines> = [];
  try { lines = parseQuantityLines(formData.entries()); }
  catch (error) { redirect(back(shipmentId, "error", error instanceof Error ? error.message : "Проверьте количества")); }
  if (!lines.length) redirect(back(shipmentId, "error", "Укажите количество хотя бы для одной позиции"));
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("apply_shipment_document_quantities", { p_extraction_id: extractionId, p_targets: targets, p_lines: lines });
  if (error) redirect(back(shipmentId, "error", ruleViolationMessage(error, "Не удалось записать количества по документу.")));
  await runDocumentCheckAfterRecognition(supabase, shipmentId);
  revalidatePath(`/shipments/${shipmentId}`);
  const changed = Number((data as { changed?: number } | null)?.changed ?? 0);
  redirect(back(shipmentId, "success", changed ? `Количества по документу записаны: изменено значений — ${changed}` : "Количества совпадают с уже записанными, изменений нет"));
}
