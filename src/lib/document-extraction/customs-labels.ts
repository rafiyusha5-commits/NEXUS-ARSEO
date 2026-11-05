// Normalize only known box labels split into PDF word/punctuation cells.
// Numeric cells stay separate; an absent goods row is never reconstructed.
const labels = [
  "ДЕКЛАРАЦИЯ НА ТОВАРЫ", "5 Всего т-ов", "12 Общая таможенная стоимость",
  "22 Валюта", "23 Курс валюты", "Маркировка и количество", "32 Товар",
  "33 Код товара", "С N", "42 Цена товара", "45 Таможенная стоимость",
  "46 Статистическая стоимость", "Графа 31 Описание товара",
];
const patterns = labels.map(label => ({
  label,
  pattern: new RegExp("(?<![\\p{L}\\p{N}])" + label.split(/\s+/u)
    .flatMap(word => word.split(/(?=-)|(?<=-)/u))
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("[ \\t\\u00a0|]*") + "(?![\\p{L}\\p{N}])", "giu"),
}));
export function normalizeCustomsLabels(raw: string) {
  let result = raw.replace(/\u00a0/gu, " ");
  for (const { label, pattern } of patterns) result = result.replace(pattern, label);
  return result.replace(/\|(?:[ \t\u00a0]*\|)+/gu, "|")
    .replace(/^[ \t\u00a0]+/gmu, "")
    .replace(/^\|[ \t]*(?=Маркировка и количество)/gmu, "")
    .replace(/32 Товар[ \t|]+33 Код товара/gu, "32 Товар 33 Код товара");
}
