import type { CommodityLine } from "./commodity-evidence.ts";

export function customsAmount(value: string): number | null {
  const v = value.trim().replace(/[ \u00a0]/g, "");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2,3}$/.test(v)) return null;
  const amount = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

const definitions = [
  { key: "amount", label: "Сумма цен товарных строк / графа 22", header: "Сумма по счёту (гр. 22)" },
  { key: "customsValue", label: "Сумма таможенных стоимостей / графа 12", header: "Общая таможенная стоимость (гр. 12)" },
] as const;
const money = (n: number) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(n);

// The parser and the explicitly mapped view use the same completeness and sum rules.
export function customsTotals(items: CommodityLine[], expected: number | null, warnings: string[], totals: [number | null, number | null]) {
  return definitions.map((definition, index) => {
    const total = totals[index];
    const complete = items.length > 0 && items.length === expected && !warnings.length
      && items.every(item => !item.warnings.length && item[definition.key] !== null && Number.isFinite(item[definition.key]) && item[definition.key]! >= 0)
      && new Set(items.map(item => item.number)).size === items.length;
    const sum = items.reduce((acc, item) => acc + (item[definition.key] ?? 0), 0);
    const matched = complete && total !== null && Number.isFinite(total) && total >= 0 && Math.abs(sum - total) <= 0.011;
    return { label: definition.label, warning: `${definition.label}: итог не подтверждён`, matched,
      value: complete && total !== null ? `${money(sum)} · ${matched ? "совпадает" : "РАСХОЖДЕНИЕ"}` : "Полнота сумм не подтверждена" };
  });
}

// A derived, read-only view. Never change the persisted original or suppress unknown warnings.
export function mappedCustomsSummary(fields: Array<{label: string; value: string}>, items: CommodityLine[], expected: number | null, warnings: string[]) {
  const context = warnings.filter(w => !definitions.some(d => w === `${d.label}: итог не подтверждён`)
    && !(items.length > 0 && items.every(i => !i.warnings.length) && w === "Есть строки, требующие проверки по оригиналу."));
  const headers = definitions.map(d => {
    const matches = fields.filter(f => f.label === d.header);
    return matches.length === 1 ? customsAmount(matches[0].value) : null;
  });
  const totals = customsTotals(items, expected, context, [headers[0], headers[1]]);
  return { fields: fields.filter(f => !definitions.some(d => d.label === f.label)).concat(totals.map(t => ({label:t.label, value:t.value}))),
    warnings: [...context, ...totals.filter(t => !t.matched).map(t => t.warning)] };
}
