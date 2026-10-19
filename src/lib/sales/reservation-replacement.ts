export type Allocation = { item_id: string; balance_id: string; sale_quantity: number };
export type AllocationView = Allocation & { batch_number: string; quantity: number; uom: string; sale_uom: string; sku: string; pct: number };
export type ReplacementSnapshot = {
  order: { id: string; status: string; date: string; today: string };
  items: { id: string; product_id: string; sku: string; quantity: number; uom: string; required_pct: number | null }[];
  reservations: { id: string; item_id: string; balance_id: string; batch_number: string; quantity: number; uom: string; sale_quantity: number }[];
  balances: { id: string; product_id: string; batch_number: string; status: string; expiry: string; uom: string; free: number; pct: number }[];
  packaging: { product_id: string; uom: string; units: number }[];
};
export type ReplacementPreview = { snapshot: ReplacementSnapshot; plan: AllocationView[] | null };
export const replacementPermissions = ["sales.view", "sales.manage", "sales.reserve", "sales.override_fefo", "inventory.view", "products.view"];
export const replacementUnits: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал.", truck: "фура" };
export function candidateWarning(balance: ReplacementSnapshot["balances"][number], item: ReplacementSnapshot["items"][number], order: ReplacementSnapshot["order"]): string | null {
  if (balance.status !== "available") return balance.status === "quarantine" ? "Карантин" : "Партия недоступна / заблокирована";
  if (balance.expiry < (order.date > order.today ? order.date : order.today)) return "Срок годности истекает до отгрузки";
  if (item.required_pct !== null && balance.pct < item.required_pct) return "ОСГ ниже требования: нужно письмо именно на эту позицию и партию";
  return null;
}

// Do not relay arbitrary SQL/credit-control messages (which may contain hidden financial amounts).
export function replacementError(error: { code?: string; message?: string } | null): string {
  if (error?.code === "42501") return "Недостаточно прав. Обновите страницу или обратитесь к администратору.";
  if (error?.code === "P0001" && error.message && /^(Недостаточный свободный|Выбранная партия|Упаковка отсутствует|Количество должно|Каждая выбранная|ОСГ новой партии|Дата или состояние|Позиции или требования|Резервы заказа|Остаток или состояние|Упаковка товара|Гарантийные письма|Состояние заказа|Остаток и действующие|Заказ должен|Слишком большой|Заказ недоступен|Идентификатор запроса|Укажите идентификатор)/.test(error.message)) return error.message;
  return "Замена не выполнена: проверьте распределение и условия подтверждения заказа. Обновите варианты. Исходные резервы сохранены.";
}
