"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";
import { readReceivingLines } from "@/lib/shipments/receiving-lines";

// Receiving from a phone: the same lines and the same receive_shipment_transport as the full version (202611010100);
// every rule and right is checked by the database.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }

export async function receiveTransportMobile(data: FormData) {
  const { profile, supabase } = await requireUser();
  const shipmentId = text(data, "shipment_id");
  const transportId = text(data, "transport_id");
  if (!uuidPattern.test(shipmentId) || !uuidPattern.test(transportId)) redirect("/m/receive");
  const back = (message: string): never => redirect(`/m/receive/${transportId}?error=${encodeURIComponent(message)}`);
  let lines: ReturnType<typeof readReceivingLines> = [];
  try { lines = readReceivingLines(data); } catch (error) { back(error instanceof Error ? error.message : "Проверьте партии приёмки"); }
  const location = text(data, "location_id");
  const { error } = await supabase.rpc("receive_shipment_transport", {
    p_transport_id: transportId, p_location_id: uuidPattern.test(location) ? location : null, p_lines: lines,
    p_performed_by_name: text(data, "performed_by_name") || profile.full_name, p_notes: text(data, "notes") || null,
  });
  if (error) back(ruleViolationMessage(error, "Не удалось провести приёмку автомобиля."));
  revalidatePath(`/shipments/${shipmentId}`); revalidatePath("/shipments"); revalidatePath("/inventory"); revalidatePath("/inventory/movements");
  redirect(`/m/receive?success=${encodeURIComponent("Приёмка проведена: товар на складе.")}`);
}
