"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { ruleViolationMessage } from "@/lib/errors/public-message";

// Batches of the packing list (202611280700): the database checks the rights, the item, the truck not yet received,
// the number, the dates and duplicates; these actions only pass the form.
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function text(data: FormData, key: string) { const value = data.get(key); return typeof value === "string" ? value.trim() : ""; }
function day(value: string) { return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null; }
function back(shipmentId: string, type: "error" | "success", message: string): never {
  redirect(`/shipments/${shipmentId}/batches?${type}=${encodeURIComponent(message)}`);
}

export async function addExpectedBatch(data: FormData) {
  const { supabase } = await requireUser();
  const shipmentId = text(data, "shipment_id");
  const itemId = text(data, "item_id");
  if (!uuidPattern.test(shipmentId)) redirect("/shipments");
  if (!uuidPattern.test(itemId)) back(shipmentId, "error", "Выберите позицию поставки");
  const quantityText = text(data, "quantity").replace(/[\s ]/g, "").replace(",", ".");
  const packagesText = text(data, "packages");
  if (quantityText && !/^\d+(?:\.\d{1,3})?$/.test(quantityText)) back(shipmentId, "error", "Количество — числом, не более трёх знаков после запятой");
  if (packagesText && !/^\d{1,3}$/.test(packagesText)) back(shipmentId, "error", "Наклеек на партию — от 1 до 100");
  const { error } = await supabase.rpc("add_expected_batch", {
    p_shipment_item_id: itemId, p_batch_number: text(data, "batch_number"), p_expiry_date: day(text(data, "expiry_date")),
    p_manufacture_date: day(text(data, "manufacture_date")), p_quantity: quantityText ? Number(quantityText) : null,
    p_packages: packagesText ? Number(packagesText) : null, p_source: text(data, "source") === "packing_list" ? "packing_list" : "manual",
    p_source_note: text(data, "source_note") || null,
  });
  if (error) back(shipmentId, "error", ruleViolationMessage(error, "Не удалось добавить партию."));
  revalidatePath(`/shipments/${shipmentId}/batches`);
  back(shipmentId, "success", `Партия ${text(data, "batch_number")} добавлена. Наклейку можно печатать.`);
}

export async function cancelExpectedBatch(data: FormData) {
  const { supabase } = await requireUser();
  const shipmentId = text(data, "shipment_id");
  const id = text(data, "expected_batch_id");
  if (!uuidPattern.test(shipmentId)) redirect("/shipments");
  if (!uuidPattern.test(id)) back(shipmentId, "error", "Партия не выбрана");
  const { error } = await supabase.rpc("cancel_expected_batch", { p_id: id, p_reason: text(data, "reason") });
  if (error) back(shipmentId, "error", ruleViolationMessage(error, "Не удалось отменить партию."));
  revalidatePath(`/shipments/${shipmentId}/batches`);
  back(shipmentId, "success", "Партия отменена. Напечатанная наклейка при сканировании скажет, что она недействительна.");
}
