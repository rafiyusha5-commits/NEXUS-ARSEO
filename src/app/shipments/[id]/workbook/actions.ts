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

/** Draft client orders from the reviewed distribution: one per ticked «Продажа в …» column, all in one transaction. */
export async function createDistributionOrders(form: FormData) {
  const id = text(form, "shipment_id");
  if (!isUuid(id)) redirect("/shipments");
  const file = text(form, "file");
  const back = (kind: "error" | "success", message: string) => `/shipments/${id}/workbook?${file ? `file=${encodeURIComponent(file)}&` : ""}${kind}=${encodeURIComponent(message)}#distribution`;
  if (text(form, "confirm") !== "yes") redirect(back("error", "Подтвердите, что проверили клиентов и количества"));
  const orders: { customer_id: string; currency_id: string; planned_shipment_date: string; items: { product_id: string; quantity: number }[] }[] = [];
  for (const column of new Set(form.getAll("order").map(String))) {
    const customer = text(form, `customer:${column}`), currency = text(form, `currency:${column}`), date = text(form, `date:${column}`);
    if (!isUuid(customer)) redirect(back("error", "Выберите клиента для каждого отмеченного заказа"));
    if (!isUuid(currency) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) redirect(back("error", "Укажите валюту и дату отгрузки"));
    let items: { productId?: unknown; quantity?: unknown }[] = [];
    try { items = JSON.parse(text(form, `items:${column}`)); } catch { redirect(back("error", "Обновите страницу и повторите")); }
    const clean = Array.isArray(items) ? items.filter(item => typeof item.productId === "string" && isUuid(item.productId) && typeof item.quantity === "number" && item.quantity > 0)
      .map(item => ({ product_id: item.productId as string, quantity: item.quantity as number })) : [];
    if (!clean.length) redirect(back("error", "В заказе нет строк"));
    orders.push({ customer_id: customer, currency_id: currency, planned_shipment_date: date, items: clean });
  }
  if (!orders.length) redirect(back("error", "Отметьте хотя бы один заказ"));
  if (new Set(orders.map(order => order.customer_id)).size !== orders.length) redirect(back("error", "Один клиент выбран для двух столбцов. Объедините их в таблице"));
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("create_distribution_orders", { p_shipment_id: id, p_source_file_id: text(form, "source"), p_orders: orders });
  if (error || !data) redirect(back("error", ruleViolationMessage(error, "Не удалось создать заказы")));
  revalidatePath("/sales"); revalidatePath(`/shipments/${id}/workbook`);
  const result = data as { orders: unknown[]; lines: number };
  redirect(back("success", `Создано черновиков заказов: ${result.orders.length}, строк: ${result.lines}. Цены подставлены из прайса — проверьте заказы в «Продажах».`));
}

/** Remembers which «Вн расчеты» of the folder this shipment works with. */
export async function chooseShipmentWorkbook(form: FormData) {
  const id = text(form, "shipment_id");
  if (!isUuid(id)) redirect("/shipments");
  const file = text(form, "file");
  if (!/^[A-Za-z0-9_-]{10,120}$/.test(file)) redirect(`/shipments/${id}/workbook?choose=1&error=${encodeURIComponent("Выберите таблицу")}`);
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("choose_shipment_workbook", { p_shipment_id: id, p_file_id: file });
  if (error) redirect(`/shipments/${id}/workbook?choose=1&error=${encodeURIComponent(ruleViolationMessage(error, "Не удалось сохранить выбор таблицы"))}`);
  revalidatePath(`/shipments/${id}/workbook`);
  redirect(`/shipments/${id}/workbook?success=${encodeURIComponent("Таблица выбрана для поставки. Дальше эта страница открывает её сразу")}`);
}
