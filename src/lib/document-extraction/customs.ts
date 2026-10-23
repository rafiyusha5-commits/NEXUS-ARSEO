import { parseDeclarationItems, type CommodityLine } from "./commodity-evidence.ts";
// Read-only document evidence. These fields never enter shipment confirmation or finance actions.
export type CustomsRecord = {
  kind: "declaration" | "assessment";
  fields: Array<{ label: string; value: string }>;
  warnings: string[];
  items?: CommodityLine[];
  currency?: string | null;
  expectedCount?: number | null;
  invoiceNumbers?: string[];
  packingNumbers?: string[];
  validationWarnings?: string[];
};

export function isCustomsForm(text: string) {
  return /ДЕКЛАРАЦИЯ\s+НА\s+ТОВАРЫ|Assessment\s+Notice/iu.test(text);
}

export type PdfTextItem = { str: string; transform: number[] };
export function customsLayout(items: PdfTextItem[]) {
  const rows = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    if (!item.str || !Number.isFinite(item.transform[5]) || !Number.isFinite(item.transform[4])) continue;
    const y = Math.round(item.transform[5]);
    rows.set(y, [...(rows.get(y) ?? []), item]);
  }
  return [...rows].sort((a, b) => b[0] - a[0])
    .map(([, row]) => row.sort((a, b) => a.transform[4] - b.transform[4]).map(item => item.str).join(" | ")).join("\n");
}

export function customsAmount(value: string): number | null {
  const v = value.trim().replace(/[ \u00a0]/g, "");
  if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2,3}$/.test(v)) return null;
  const amount = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}
const money = (value: number) => new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 3 }).format(value);
function date(value: string) {
  const m = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]}-${m[1]}`;
  const d = new Date(iso + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseCustomsForm(raw: string): CustomsRecord | null {
  if (!isCustomsForm(raw)) return null;
  const first = raw.split("\f")[0];
  const lines = first.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const record: CustomsRecord = { kind: /Assessment\s+Notice/iu.test(first) ? "assessment" : "declaration", fields: [], warnings: [] };
  const put = (label: string, value: string | null | undefined) => { if (value) record.fields.push({ label, value }); };
  if (record.kind === "declaration") {
    const number = first.match(/(?:^|[\s|])(\d{5,8}\/(\d{6})\/\d{7})(?=$|[\s|])/u);
    put("Номер декларации", number?.[1]);
    if (number) put("Дата регистрации (из номера ДТ)", date(`${number[2].slice(0, 2)}/${number[2].slice(2, 4)}/20${number[2].slice(4)}`));
    // Only header boxes 12, 22 and 23; never confuse item box 45 with the declaration total.
    const header = first.split(/31 Грузовые/u)[0];
    const headerLines = header.split("\n").map(line => line.trim()).filter(Boolean);
    const valueLabel = headerLines.findIndex(line => line.includes("12 ОБЩАЯ ТАМОЖЕННАЯ СТОИМОСТЬ"));
    const valueBlock = valueLabel >= 0 ? headerLines.slice(valueLabel + 1, valueLabel + 5).join("\n") : "";
    const customsValue = valueBlock.match(/(?:^|\n)[A-Z]{2}\s*\|\s*(\d[\d ]*,\d{2})(?:\s*\n|$)/u);
    const value = customsValue ? customsAmount(customsValue[1]) : null;
    if (value !== null) put("Общая таможенная стоимость (гр. 12)", money(value));
    const invoice = header.match(/\b([A-Z]{3})\s*\|\s*(\d[\d ]*,\d{2})\s*\|\s*(\d[\d ]*,\d{2,3})\s*\|/u);
    if (invoice && /22 Валюта.*23\s+Курс валюты/u.test(header)) {
      record.currency = invoice[1];
      put("Валюта счёта (гр. 22)", invoice[1]);
      const amount = customsAmount(invoice[2]), rate = customsAmount(invoice[3]);
      if (amount !== null) put("Сумма по счёту (гр. 22)", money(amount));
      if (rate !== null) put("Курс валюты (гр. 23)", money(rate));
    }
    const goods = parseDeclarationItems(raw);
    record.items = goods.items;
    record.invoiceNumbers = [...new Set([...raw.matchAll(/^\d+\s*\|\s*\d+\s*\|\s*04021\s*\|\s*([^|\n]+)\|/gmu)].map(match => match[1].trim()))];
    record.expectedCount = goods.expectedCount;
    record.packingNumbers = [...new Set([...raw.matchAll(/^\d+\s*\|\s*\d+\s*\|\s*04131\s*\|\s*([^|\n]+)\|/gmu)].map(match => match[1].trim()))];
    record.validationWarnings = [...goods.warnings];
    record.warnings.push(...goods.warnings);
    for (const [key, label, total] of [
      ["amount", "Сумма цен товарных строк / графа 22", invoice ? customsAmount(invoice[2]) : null],
      ["customsValue", "Сумма таможенных стоимостей / графа 12", value],
    ] as const) {
      const complete = goods.items.length > 0 && goods.items.length === goods.expectedCount && !goods.warnings.length && goods.items.every(item => item[key] !== null);
      const sum = goods.items.reduce((acc, item) => acc + (item[key] ?? 0), 0);
      if (!complete || total === null || Math.abs(sum - total) > 0.011) record.validationWarnings.push(`${label}: итог не подтверждён`);
      put(label, complete && total !== null ? `${money(sum)} · ${Math.abs(sum - total) <= 0.011 ? "совпадает" : "РАСХОЖДЕНИЕ"}` : "Полнота сумм не подтверждена");
    }
    record.warnings.push("Товарные строки — результат чтения, требующий сверки. Начисления по отдельным товарам здесь не рассчитываются.");
  } else {
    put("Код таможенного органа", first.match(/Customs office:\s*\|?\s*(\d{5,8})/iu)?.[1]);
    const references = first.match(/(\d{2}\/\d{2}\/\d{4})\s+D\s+(\d+)[^\n]*?\|\s*(\d{2}\/\d{2}\/\d{4})\s+K\s+(\d+)/u);
    if (references) {
      put("Таможенная ссылка", `D ${references[2]}`);
      put("Дата таможенной ссылки", date(references[1]));
      put("Номер расчёта", `K ${references[4]}`);
      put("Дата расчёта", date(references[3]));
    }
    const taxes = new Map<string, number>();
    const names: Record<string, string> = { "1010": "Таможенный сбор · 1010", "2010": "Ввозная пошлина · 2010", "5060": "НДС · 5060" };
    let duplicate = false, unreadTax = false;
    for (const line of lines) {
      const m = line.match(/^(\d{4})\s*\|[^|]+\|\s*([\d. ,]+)$/u);
      if (!m) { if (/^\d{4}\s*\|/u.test(line)) unreadTax = true; continue; }
      const value = customsAmount(m[2]);
      if (value === null) { unreadTax = true; record.warnings.push(`Не удалось прочитать сумму по коду ${m[1]}.`); continue; }
      if (taxes.has(m[1])) { duplicate = true; continue; }
      taxes.set(m[1], value);
      put(names[m[1]] ?? `Начисление · ${m[1]}`, money(value));
    }
    const totalIndex = lines.findIndex(line => /^Total assessed amount for the declaration$/iu.test(line));
    // PDF text ordering puts this particular form's amount immediately before its label.
    const total = totalIndex > 0 ? customsAmount(lines[totalIndex - 1]) : null;
    if (total !== null) put("Всего начислено по декларации", money(total));
    const sum = [...taxes.values()].reduce((a, b) => a + b, 0);
    if (duplicate || unreadTax || !taxes.size || total === null || Math.abs(sum - total) > 0.011)
      record.warnings.push("Итог начислений не подтверждён суммой строк: проверьте оригинал.");
    else put("Проверка суммы строк", "Совпадает с итогом документа");
    record.warnings.push("Валюта сумм в этой форме не напечатана. Начисление не подтверждает оплату; расходы и платежи автоматически не создаются.");
  }
  if (!record.fields.length) record.warnings.push("Форма найдена, но её расположение полей не поддержано: нужна ручная сверка.");
  return record;
}
