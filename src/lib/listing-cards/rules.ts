// Pure rules for customer product listing cards (карты ввода / вывода товара).
// The status graph mirrors private.guard_listing_card_update() in the database; the
// database remains the authority, these functions drive the interface and validation.

export const CARD_TYPES = ["input", "output"] as const;
export const CARD_STATUSES = [
  "draft",
  "submitted",
  "approved_by_customer",
  "rejected_by_customer",
  "cancelled",
  "superseded",
] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];
export const CARD_UOMS = ["piece", "box", "layer", "pallet"] as const;

export const cardTypeLabel: Record<string, string> = { input: "Ввод от поставщика", output: "Вывод для покупателя" };
export const cardStatusLabel: Record<string, string> = {
  draft: "Черновик",
  submitted: "Отправлена контрагенту",
  approved_by_customer: "Утверждена контрагентом",
  rejected_by_customer: "Отклонена контрагентом",
  cancelled: "Отменена",
  superseded: "Заменена новой версией",
};
export const cardUomLabel: Record<string, string> = { piece: "шт.", box: "кор.", layer: "слой", pallet: "пал." };

const TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  draft: ["submitted", "cancelled"],
  submitted: ["approved_by_customer", "rejected_by_customer", "cancelled"],
  approved_by_customer: ["superseded"],
  rejected_by_customer: [],
  cancelled: [],
  superseded: [],
};

export function isCardStatus(value: string): value is CardStatus {
  return (CARD_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: string, to: string) {
  return isCardStatus(from) && isCardStatus(to) && TRANSITIONS[from].includes(to);
}

// Only a draft may change: header fields and items. Anything else needs a new version.
export function isCardEditable(status: string) {
  return status === "draft";
}

// A new version is created from the latest version of a chain once it is final for
// the customer (approved or rejected) or was cancelled.
export function canCreateNewVersion(status: string, hasSuccessor: boolean) {
  return !hasSuccessor && ["approved_by_customer", "rejected_by_customer", "cancelled"].includes(status);
}

export type CardPermissions = {
  create: boolean;
  update: boolean;
  archive: boolean;
  approve: boolean;
  change_status: boolean;
};

export type CardAction = "edit" | "add_item" | "submit" | "decide" | "cancel" | "new_version";

export function availableCardActions(
  card: { status: string; itemCount: number; hasSuccessor: boolean },
  can: CardPermissions,
): CardAction[] {
  const actions: CardAction[] = [];
  if (isCardEditable(card.status) && can.update) actions.push("edit", "add_item");
  if (card.status === "draft" && can.change_status && card.itemCount > 0) actions.push("submit");
  if (card.status === "submitted" && can.approve) actions.push("decide");
  if (canTransition(card.status, "cancelled") && can.archive) actions.push("cancel");
  if (canCreateNewVersion(card.status, card.hasSuccessor) && can.create) actions.push("new_version");
  return actions;
}

export type CardItemInput = {
  product_id: string;
  required_quantity: number;
  uom: string;
  counterparty_sku: string | null;
  price: number | null;
  currency_id: string | null;
  comment: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUANTITY = 99_999_999_999.999; // numeric(14,3)
const MAX_PRICE = 9_999_999_999.9999; // numeric(14,4)

function decimals(value: number) {
  const text = String(value);
  if (text.includes("e")) return 0;
  return text.includes(".") ? text.split(".")[1].length : 0;
}

// Mirrors the constraints of product_listing_card_items.
export function validateCardItem(item: CardItemInput, existingProductIds: Iterable<string> = []): string | null {
  if (!UUID.test(item.product_id)) return "Выберите товар";
  if (new Set([...existingProductIds].map((id) => id.toLowerCase())).has(item.product_id.toLowerCase())) {
    return "Этот товар уже есть в карте — измените его строку";
  }
  if (!Number.isFinite(item.required_quantity) || item.required_quantity <= 0) return "Требуемое количество должно быть больше нуля";
  if (item.required_quantity > MAX_QUANTITY || decimals(item.required_quantity) > 3) {
    return "Количество: не больше 3 знаков после запятой";
  }
  if (!(CARD_UOMS as readonly string[]).includes(item.uom)) return "Выберите единицу измерения";
  if (item.counterparty_sku !== null && (item.counterparty_sku.trim().length === 0 || item.counterparty_sku.length > 100)) {
    return "Артикул контрагента — от 1 до 100 символов";
  }
  if (item.price !== null) {
    if (!Number.isFinite(item.price) || item.price < 0) return "Цена не может быть отрицательной";
    if (item.price > MAX_PRICE || decimals(item.price) > 4) return "Цена: не больше 4 знаков после запятой";
    if (!item.currency_id || !UUID.test(item.currency_id)) return "Для цены выберите валюту";
  }
  if (item.comment && item.comment.length > 1000) return "Комментарий не должен быть длиннее 1000 символов";
  return null;
}

export type CardHeaderInput = {
  card_type: string;
  counterparty_id: string;
  template_id: string | null;
  title: string | null;
  effective_date: string | null;
  notes: string | null;
};

export function validateCardHeader(header: CardHeaderInput): string | null {
  if (!(CARD_TYPES as readonly string[]).includes(header.card_type)) return "Выберите тип карты: ввод или вывод";
  if (!UUID.test(header.counterparty_id)) return header.card_type === "input" ? "Выберите поставщика" : "Выберите покупателя";
  if (header.template_id && !UUID.test(header.template_id)) return "Некорректный шаблон";
  if (header.title && header.title.length > 200) return "Название не должно быть длиннее 200 символов";
  if (header.effective_date && !/^\d{4}-\d{2}-\d{2}$/.test(header.effective_date)) return "Некорректная дата вступления в силу";
  if (header.notes && header.notes.length > 2000) return "Примечание не должно быть длиннее 2000 символов";
  return null;
}

// Decimal input from a form: accepts "1 200,5" and "1200.5"; empty means null.
export function parseDecimal(value: string): number | null {
  const normalized = value.replace(/\s/g, "").replace(",", ".");
  if (!normalized) return null;
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return Number.NaN;
  return Number(normalized);
}
