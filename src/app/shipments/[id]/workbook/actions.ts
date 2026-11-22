"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth/access";
import { isUuid } from "@/lib/documents/rules";
import { ruleViolationMessage } from "@/lib/errors/public-message";

const text = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const amount = (value: string) => { const number = Number(value); return value !== "" && Number.isFinite(number) ? number : null; };

/** Applies the ticked changes of the reviewed «Вн расчеты»; the values come from the review page, checked again in the database. */
export async function applyOrderWorkbook(form: FormData) {
  const id = text(form, "shipment_id");
  if (!isUuid(id)) redirect("/shipments");
  const file = text(form, "file");
  const back = (kind: "error" | "success", message: string) => `/shipments/${id}/workbook?${file ? `file=${encodeURIComponent(file)}&` : ""}${kind}=${encodeURIComponent(message)}`;
  if (text(form, "confirm") !== "yes") redirect(back("error", "Подтвердите, что проверили изменения"));
  const { supabase } = await requireUser();
  const ticked = new Set(form.getAll("apply").map(String));
  const add: { product_id: string; quantity: number; price: number | null }[] = [];
  const update: { item_id: string; seen_quantity: number; seen_price: number | null; quantity: number; price: number | null }[] = [];
  for (const key of ticked) {
    const [kind, ref] = key.split(":");
    if (!isUuid(ref)) continue;
    const quantity = amount(text(form, `quantity:${key}`)), price = amount(text(form, `price:${key}`));
    if (quantity === null || quantity <= 0) redirect(back("error", "Некорректное количество в одной из строк"));
    if (kind === "add") add.push({ product_id: ref, quantity, price });
    if (kind === "update") update.push({ item_id: ref, seen_quantity: amount(text(form, `seen_quantity:${key}`)) ?? -1, seen_price: amount(text(form, `seen_price:${key}`)), quantity, price });
  }
  const ready = ticked.has("ready_date") && /^\d{4}-\d{2}-\d{2}$/.test(text(form, "ready_date")) ? text(form, "ready_date") : null;
  if (!add.length && !update.length && !ready) redirect(back("error", "Отметьте хотя бы одно изменение"));
  const { data, error } = await supabase.rpc("apply_order_workbook", { p_shipment_id: id, p_planned_ready_date: ready, p_add: add, p_update: update });
  if (error || !data) redirect(back("error", ruleViolationMessage(error, "Не удалось применить изменения")));
  revalidatePath(`/shipments/${id}`);
  const result = data as { added: number; updated: number; ready_date: boolean };
  redirect(`/shipments/${id}?success=${encodeURIComponent(`Из «Вн расчетов» добавлено позиций: ${result.added}, изменено: ${result.updated}${result.ready_date ? ", дата готовности обновлена" : ""}.`)}`);
}
