"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// Picking and shipping from a phone (202611280600). The database checks the batch against the reservation, the place,
// the quantity and the rights; shipping runs the existing fulfillment of the order.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function uuid(data: FormData, key: string, required = true) {
  const value = text(data, key);
  if (uuidPattern.test(value)) return value;
  if (required) throw new Error(`Некорректное поле: ${key}`);
  return null;
}
const back = (saleId: string, type: "error" | "success", message: string): never =>
  redirect(`/m/pick/${saleId}?${type}=${encodeURIComponent(message)}`);

export async function confirmPick(data: FormData) {
  const { supabase } = await requireUser();
  const saleId = uuid(data, "sale_id")!;
  const raw = text(data, "quantity").replace(/[\s ]/g, "").replace(",", ".");
  const quantity = /^\d+(?:\.\d{1,3})?$/.test(raw) ? Number(raw) : null;
  if (!quantity) back(saleId, "error", "Укажите количество числом, не более трёх знаков после запятой");
  const { error } = await supabase.rpc("confirm_pick", {
    p_reservation_id: uuid(data, "reservation_id")!, p_batch_id: uuid(data, "batch_id")!, p_location_id: uuid(data, "location_id", false), p_quantity: quantity!,
  });
  if (error) back(saleId, "error", ruleViolationMessage(error, "Не удалось записать отбор."));
  revalidatePath(`/m/pick/${saleId}`);
  back(saleId, "success", "Отбор записан.");
}

export async function shipPickedOrder(data: FormData) {
  const { supabase } = await requireUser();
  const saleId = uuid(data, "sale_id")!;
  const { error } = await supabase.rpc("ship_picked_order", { p_sale_id: saleId });
  if (error) back(saleId, "error", ruleViolationMessage(error, "Не удалось отгрузить заказ."));
  revalidatePath(`/sales/${saleId}`); revalidatePath("/sales"); revalidatePath("/inventory"); revalidatePath("/m/pick");
  back(saleId, "success", "Заказ отгружен.");
}
