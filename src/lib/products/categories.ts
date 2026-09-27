export const PRODUCT_CATEGORIES = [
  "Конфеты",
  "Шоколад",
  "Мармелад",
  "Печенье и снеки",
  "Пасты и кремы",
  "Напитки",
  "Вода",
  "Прочее",
] as const;

export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

