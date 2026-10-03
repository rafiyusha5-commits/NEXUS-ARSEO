"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { loadPermissions } from "@/lib/permissions";
import { extractShipmentSources } from "@/lib/document-extraction/shipment-service";
import { publicErrorMessage } from "@/lib/errors/public-message";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const value = (formData: FormData, key: string) => {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.trim() : "";
};
const back = (shipmentId: string, kind: "error" | "success", message: string) =>
  `/shipments/${shipmentId}?${kind}=${encodeURIComponent(message)}#source-documents`;

export async function extractShipmentSourcesAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  if (!UUID.test(shipmentId)) redirect("/shipments?error=Некорректная поставка");
  const { supabase } = await requireUser();
  const permissions = await loadPermissions(supabase, ["source_documents.extract", "documents.view", "shipments.view"] as const);
  if (!permissions["source_documents.extract"] || !permissions["documents.view"] || !permissions["shipments.view"])
    redirect(back(shipmentId, "error", "Недостаточно прав для распознавания исходных документов"));

  let summary;
  try { summary = await extractShipmentSources(supabase, shipmentId); }
  catch (error) { redirect(back(shipmentId, "error", publicErrorMessage(error,"Не удалось распознать документы."))); }
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, summary.failed || summary.review ? "error" : "success", `Распознано автоматически: ${summary.confirmed}; требуется проверка: ${summary.review}; не прочитано: ${summary.failed}`));
}

export async function confirmShipmentSourceAction(formData: FormData) {
  const shipmentId = value(formData, "shipment_id");
  const extractionId = value(formData, "extraction_id");
  if (!UUID.test(shipmentId) || !UUID.test(extractionId)) redirect("/shipments?error=Некорректные данные");
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("confirm_shipment_source_extraction", { p_extraction_id: extractionId });
  if (error) redirect(back(shipmentId, "error", publicErrorMessage(error,"Не удалось подтвердить распознанные данные.")));
  revalidatePath(`/shipments/${shipmentId}`);
  redirect(back(shipmentId, "success", "Распознанные данные подтверждены и будут использованы при формировании документов"));
}
