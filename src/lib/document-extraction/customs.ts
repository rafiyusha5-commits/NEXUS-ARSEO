import { parseDeclarationItems, type CommodityLine } from "./commodity-evidence.ts";
// Read-only document evidence. These fields never enter shipment confirmation or finance actions.
export type CustomsRecord = {
  kind: "declaration" | "assessment" | "value_declaration" | "transit";
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
  return /ДЕКЛАРАЦИЯ\s+НА\s+ТОВАРЫ|Assessment\s+Notice|Форма\s+ДТС-1|ТРАНЗИТНАЯ\s+ДЕКЛАРАЦИЯ/iu.test(text);
}

export type PdfTextItem = { str: string; transform: number[]; width?: number };
export function customsLayout(items: PdfTextItem[]) {
  // Some exporters emit one PDF item per glyph. Separators between these glyphs
  // destroy both words and amounts. Use geometry only for such pages; retain
  // the established column layout for PDFs already containing complete cells.
  const visible = items.filter(item => item.str.trim());
  const fragmented = visible.length > 0 && visible.filter(item => item.str.trim().length === 1).length / visible.length > 0.35;
  const rows = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    if (!item.str || !Number.isFinite(item.transform[5]) || !Number.isFinite(item.transform[4])) continue;
    const y = Math.round(item.transform[5]);
    rows.set(y, [...(rows.get(y) ?? []), item]);
  }
  return [...rows].sort((a, b) => b[0] - a[0])
    .map(([, row]) => {
      row.sort((a, b) => a.transform[4] - b.transform[4]);
      return row.map((item, index) => {
        if (!index) return item.str;
        const previous = row[index - 1];
        if (!fragmented || !Number.isFinite(previous.width)) return " | " + item.str;
        const gap = item.transform[4] - previous.transform[4] - previous.width!;
        return (gap > 7 ? " | " : gap > 1 ? " " : "") + item.str;
      }).join("");
    }).join("\n");
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
  const kind = /Форма\s+ДТС-1/iu.test(first) ? "value_declaration" : /ТРАНЗИТНАЯ\s+ДЕКЛАРАЦИЯ/iu.test(first) ? "transit" : /Assessment\s+Notice/iu.test(first) ? "assessment" : "declaration";
  const record: CustomsRecord = { kind, fields: [], warnings: [] };
  const put = (label: string, value: string | null | undefined) => { if (value) record.fields.push({ label, value }); };
  if (kind === "value_declaration") {
    put("Форма", "ДТС-1 — декларация таможенной стоимости");
    put("Связанная декларация", first.match(/\b\d{5,8}\/\d{6}\/\d{7}\b/u)?.[0]);
    const invoices = first.split(/4 Номер и дата счета/u)[1]?.split(/5 Номер и дата контракта/u)[0] ?? "";
    for (const ref of invoices.matchAll(/\|\s*([\d/-]+)\s+(\d{2}\.\d{2}\.\d{4})\s*$/gmu)) put("Ссылка на счёт (гр. 4)", `${ref[1]} от ${ref[2]}`);
    const rate = raw.match(/курс пересчета\s+([A-Z]{3})\/(\d+(?:\.\d+)?)/u);
    if (rate) put("Курс пересчёта в форме", `${rate[1]} / ${rate[2]}`);
    record.warnings.push("ДТС дополняет таможенную декларацию. Ссылки могут включать товарный и транспортный счета; они не заменяют инвойс поставщика. Расчёт по товарам требует сверки с оригиналом.");
    return record;
  }
  if (kind === "transit") {
    put("Форма", "Транзитная декларация");
    put("Ссылка на CMR (гр. 44)", first.match(/02015\/\d+\/([^\s|]+)\s+ОТ\s+(\d{2}\.\d{2}\.\d{4})/u)?.slice(1).join(" от "));
    put("Ссылка на счёт (гр. 44)", first.match(/04025\/\d+\/([^\s|]+)\s+ОТ\s+(\d{2}\.\d{2}\.\d{4})/u)?.slice(1).join(" от "));
    const total = first.split(/22 Валюта и общ\. ст\. по счету/u)[1]?.split(/31\s*\|/u)[0] ?? "";
    const amount = total.match(/\|([A-Z]{3})\|\s*(\d+\.\d{2})\s*\|/u);
    if (amount) put("Стоимость по счёту (гр. 22)", `${amount[2]} ${amount[1]}`);
    record.warnings.push("Транзитная декларация не подтверждает импортный выпуск или приёмку. Сгруппированные товары здесь не используются для сравнения количества по артикулам.");
    return record;
  }
  if (record.kind === "declaration") {
    const number = first.match(/(?:^|[\s|])(\d{5,8}\/(\d{6})\/\d{7})(?=$|[\s|])/u);
    put("Номер декларации", number?.[1]);
    if (number) put("Дата регистрации (из номера ДТ)", date(`${number[2].slice(0, 2)}/${number[2].slice(2, 4)}/20${number[2].slice(4)}`));
    // Only header boxes 12, 22 and 23; never confuse item box 45 with the declaration total.
    const header = first.split(/31 Грузовые|^(?:31\s*\|\s*)?Маркировка и количество/mu)[0];
    const headerLines = header.split("\n").map(line => line.trim()).filter(Boolean);
    const valueLabel = headerLines.findIndex(line => /12 Общая таможенная стоимость/iu.test(line));
    const valueBlock = valueLabel >= 0 ? headerLines.slice(valueLabel + 1, valueLabel + 5).join("\n") : "";
    const customsValue = valueBlock.match(/(?:^|\n)(?:[A-Z]{2}\s*\|\s*)?(\d[\d ]*,\d{2})\s*\|?\s*(?:\n|$)/u);
    const value = customsValue ? customsAmount(customsValue[1]) : null;
    if (value !== null) put("Общая таможенная стоимость (гр. 12)", money(value));
    const invoice = header.match(/\b([A-Z]{3})\s*\|\s*(\d[\d ]*,\d{2})\s*\|\s*(\d[\d ]*,\d{2,3})(?:\s*\||\s*(?:\n|$))/u);
    if (invoice && /22 Валюта.*23\s+Курс валюты/u.test(header)) {
      record.currency = invoice[1];
      put("Валюта счёта (гр. 22)", invoice[1]);
      const amount = customsAmount(invoice[2]), rate = customsAmount(invoice[3]);
      if (amount !== null) put("Сумма по счёту (гр. 22)", money(amount));
      if (rate !== null) put("Курс валюты (гр. 23)", money(rate));
    }
    const goods = parseDeclarationItems(raw);
    record.items = goods.items;
    record.invoiceNumbers = [...new Set([...raw.matchAll(/^\d+\s*\|\s*\d+\s*\|?\s*04021\s*\|?\s*([^|\n]+)\|/gmu)].map(match => match[1].trim()))];
    record.expectedCount = goods.expectedCount;
    record.packingNumbers = [...new Set([...raw.matchAll(/^\d+\s*\|\s*\d+\s*\|?\s*04131\s*\|?\s*([^|\n]+)\|/gmu)].map(match => match[1].trim()))];
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
