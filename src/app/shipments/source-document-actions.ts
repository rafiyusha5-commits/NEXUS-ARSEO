"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { extractShipmentSources } from "@/lib/document-extraction/shipment-service";
import { sanitizeConfirmedSourceData, SOURCE_FIELD_DEFINITIONS } from "@/lib/document-extraction/rules";
import { publicErrorMessage, ruleViolationMessage } from "@/lib/errors/public-message";
import { describeExtractionSummary } from "@/lib/document-extraction/summary";
import { runDocumentCheckAfterRecognition } from "@/lib/document-check/run";

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
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", "Распознанные данные подтверждены и будут использованы при формировании документов"));
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
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", transportId ? "Документ привязан к автомобилю" : "Документ относится ко всей поставке"));
}
