export const documentStatusLabel: Record<string, string> = {
  uploaded: "Загружен",
  under_review: "На проверке",
  approved: "Утверждён",
  rejected: "Отклонён",
};

export const documentCategoryLabel: Record<string, string> = {
  commercial: "Коммерческие",
  shipping: "Перевозка",
  customs: "Таможня",
  quality: "Качество",
  contract: "Контракты",
  returns: "Возвраты",
  marking: "Маркировка",
  other: "Прочие",
};

export const linkEntityLabel: Record<string, string> = {
  shipment: "Поставка",
  shipment_transport: "Перевозка",
  supplier: "Поставщик",
  customer: "Клиент",
  product: "Товар",
  warehouse: "Склад",
  contract: "Контракт",
  customer_return: "Возврат",
};

export const linkRoleLabel: Record<string, string> = {
  primary: "Основной объект",
  related: "Связан",
  supporting: "Подтверждающий",
};

export const languageLabel: Record<string, string> = {
  ru: "Русский",
  kk: "Казахский",
  en: "Английский",
  other: "Другой",
};

export function formatDate(value: string | null | undefined) {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}.${month}.${year}` : "—";
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Qyzylorda",
  }).format(new Date(value));
}

export function localizedName(value: unknown) {
  if (!value || typeof value !== "object") return "—";
  const names = value as Record<string, unknown>;
  return String(names.ru ?? names.en ?? names.kk ?? "—");
}
