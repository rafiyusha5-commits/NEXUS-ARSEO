"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// A move between places of one warehouse (202611280600): one transfer document, posted at once by the database with the
// checks of the document (free stock, active place, the lock of a place under count, the right to move).
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }

export async function moveBetweenLocations(data: FormData) {
  const { supabase } = await requireUser();
  const balanceId = text(data, "balance_id");
  const toLocationId = text(data, "to_location_id");
  if (!uuidPattern.test(balanceId) || !uuidPattern.test(toLocationId)) redirect(`/m/move?error=${encodeURIComponent("Выберите остаток и место")}`);
  const back = (message: string): never =>
    redirect(`/m/move?balance=${balanceId}&to=${toLocationId}&error=${encodeURIComponent(message)}`);
  const raw = text(data, "quantity").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw) || Number(raw) <= 0) back("Укажите количество числом, не более трёх знаков после запятой");
  const { data: documentId, error } = await supabase.rpc("move_between_locations", {
    p_balance_id: balanceId, p_to_location_id: toLocationId, p_quantity: Number(raw), p_note: text(data, "note") || null,
  });
  if (error) back(ruleViolationMessage(error, "Не удалось переместить."));
  const { data: document } = await supabase.from("inventory_operation_documents").select("document_number").eq("id", String(documentId)).maybeSingle();
  revalidatePath("/inventory"); revalidatePath("/inventory/movements");
  redirect(`/m/move?success=${encodeURIComponent(`Перемещено: документ ${document?.document_number ?? "проведён"}. Отменить можно в полной версии, в документе.`)}`);
}
