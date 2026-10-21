"use server";
import { requireUser } from "@/lib/auth/access";
import { shipmentDriveGateway } from "@/lib/google/shipment-gateway";
import { shipmentDrive } from "@/lib/google/drive-server";
import { isUuid } from "@/lib/documents/rules";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

export async function saveHistoricalPreparation(form: FormData) {
  const { supabase } = await requireUser();
  const id = String(form.get("id") ?? ""), shipment = String(form.get("shipment_id") ?? "");
  if (!isUuid(id) || !isUuid(shipment)) redirect("/shipments/prepare?error=invalid");
  let error = "";
  try {
    const db = await shipmentDriveGateway(supabase);
    const binding = await db.from("shipment_drive_folders").select("folder_id").eq("shipment_id", shipment).single();
    if (binding.error || !binding.data) throw new Error("unavailable");
    await shipmentDrive().scopedReference(binding.data.folder_id, AbortSignal.timeout(12000));
    const raw = String(form.get("choices") ?? "[]");
    if (raw.length > 180000) throw new Error("invalid");
    const saved = await db.rpc("save_historical_shipment_draft", { p_id: id, p_shipment_id: shipment,
      p_prepare_new: form.get("prepare_new") === "true", p_revision: Number(form.get("revision")), p_choices: JSON.parse(raw) });
    if (saved.error) error = saved.error.code === "40001" ? "changed" : "unavailable";
  } catch { error = "unavailable"; }
  revalidatePath("/shipments/prepare");
  redirect(`/shipments/prepare?shipment=${shipment}&draft=${id}&${error ? `error=${error}` : "saved=1"}`);
}
