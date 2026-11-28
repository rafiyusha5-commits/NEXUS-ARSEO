"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// A count record from a phone: the same record_inventory_count as the full version (202611280300); the database checks
// the round, the place, the unit, the counter of a recount and the rights.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function optionalUuid(data: FormData, key: string) { const value = text(data, key); return uuidPattern.test(value) ? value : null; }

export async function recordMobileCount(data: FormData) {
  const { supabase } = await requireUser();
  const id = optionalUuid(data, "count_id");
  const productId = optionalUuid(data, "product_id");
  if (!id || !productId) redirect("/m/count");
  const round = text(data, "round") === "2" ? 2 : 1;
  const location = optionalUuid(data, "location_id");
  const back = (type: "error" | "success", message: string): never =>
    redirect(`/m/count/${id}?${round === 1 ? `location=${location ?? "none"}&` : ""}${type}=${encodeURIComponent(message)}`);
  const raw = text(data, "quantity").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d{1,3})?$/.test(raw)) back("error", "Укажите количество числом, не более трёх знаков после запятой");
  const { error } = await supabase.rpc("record_inventory_count", {
    p_count_id: id, p_round: round, p_location_id: location, p_product_id: productId, p_batch_id: optionalUuid(data, "batch_id"),
    p_uom: text(data, "uom"), p_quantity: Number(raw), p_note: text(data, "note") || null, p_supersedes_entry_id: null,
  });
  if (error) back("error", ruleViolationMessage(error, "Не удалось записать подсчёт."));
  revalidatePath(`/inventory/counts/${id}`);
  back("success", "Подсчёт записан. Сканируйте следующий товар.");
}
