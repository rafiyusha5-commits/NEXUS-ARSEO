// Reader for the Kazakhstan electronic invoice (ЭСФ, "InvoicePrintReport" PDF). The printed form is a
// fixed layout of numbered boxes, so the header is read by box numbers and the goods table (section G)
// by its row markers "1/1", "1/2", … The text layer comes from pdf-parse: labels and values are on
// separate lines and long names are wrapped, hence the careful line handling below.

export type InvoiceLine = {
  line_number: number;
  product_name: string;
  hs_code: string;
  uom: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

export type ElectronicInvoice = { data: Record<string, string>; items: InvoiceLine[] };

export const isElectronicInvoice = (text: string) => /СЧ[ЕЁ]Т-ФАКТУРА/i.test(text) && /Раздел\s+G\.\s*Данные\s+по\s+товарам/i.test(text);

const clean = (value: string) => value.replace(/ /g, " ").replace(/\s+/g, " ").trim();
const isoDate = (value: string) => {
  const match = /(\d{2})\.(\d{2})\.(\d{4})/.exec(value);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
};
const amount = (value: string | undefined) => {
  const parsed = Number((value ?? "").replace(/[\s ]/g, "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

function between(text: string, start: RegExp, end: RegExp) {
  const from = start.exec(text);
  if (!from) return "";
  const rest = text.slice(from.index + from[0].length);
  const to = end.exec(rest);
  return clean(to ? rest.slice(0, to.index) : "");
}

const after = (text: string, label: RegExp) => clean(new RegExp(`${label.source}\\s*\\n\\s*([^\\n]+)`, label.flags).exec(text)?.[1] ?? "");

// A product name is printed twice in a row (as invoiced and as declared) and wrapped differently.
function singleName(lines: string[]) {
  const squash = (value: string) => value.replace(/\s+/g, "").toLocaleLowerCase("ru-RU");
  const all = squash(lines.join(" "));
  const half = all.length / 2;
  if (all.length % 2 === 0 && all.slice(0, half) === all.slice(half)) {
    const picked: string[] = [];
    let length = 0;
    for (const line of lines) {
      if (length >= half) break;
      picked.push(line);
      length += squash(line).length;
    }
    return clean(picked.join(" "));
  }
  return clean(lines.join(" "));
}

const HEADER_NUMBERS = ["1", "2", "3", "4", "5", "6", "7", "10", "11", "12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22"];

function goodsRows(text: string): InvoiceLine[] {
  const section = text.slice(Math.max(0, text.search(/Раздел\s+G\./i)));
  const lines = section.split("\n").map(line => line.trim()).filter(Boolean);
  // The column-number row repeats at page breaks; it is not part of any item.
  const cleaned: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (HEADER_NUMBERS.every((value, offset) => lines[index + offset] === value) && cleaned.some(line => /^1\/\d+$/.test(line))) { index += HEADER_NUMBERS.length - 1; continue; }
    cleaned.push(lines[index]);
  }
  const starts = cleaned.map((line, index) => /^1\/\d+$/.test(line) ? index : -1).filter(index => index >= 0);
  const items: InvoiceLine[] = [];
  starts.forEach((start, position) => {
    const rowLines = cleaned.slice(start + 1, position + 1 < starts.length ? starts[position + 1] : undefined);
    const hs = rowLines.findIndex(line => /^\d{10}$/.test(line));
    if (hs < 0) return;
    const nameLines = rowLines.slice(rowLines[0] === "2" || /^\d$/.test(rowLines[0]) ? 1 : 0, hs);
    const quantity = amount(rowLines[hs + 2]), price = amount(rowLines[hs + 3]), total = amount(rowLines[hs + 4]);
    if (quantity === null || price === null || !nameLines.length) return;
    items.push({
      line_number: Number(cleaned[start].split("/")[1]),
      product_name: singleName(nameLines),
      hs_code: rowLines[hs],
      uom: clean(rowLines[hs + 1] ?? ""),
      quantity,
      unit_price: price,
      line_total: total ?? Math.round(quantity * price * 100) / 100,
    });
  });
  return items;
}

export function parseElectronicInvoice(rawText: string): ElectronicInvoice {
  const text = rawText.replace(/\r/g, "\n").replace(/ /g, " ");
  const data: Record<string, string> = {};
  const set = (key: string, value: string) => { if (value) data[key] = value; };

  set("invoice_number", after(text, /1\.\s*Регистрационный номер/));
  set("esf_number", after(text, /1\.1\s*Номер учетной системы/));
  set("invoice_date", isoDate(after(text, /2\.1\s*Дата выписки на бумажном носителе/)) || isoDate(after(text, /2\.\s*Дата выписки/)));
  set("shipping_date", isoDate(after(text, /3\.\s*Дата совершения оборота/)));

  set("supplier_name", between(text, /7\.1\s*Доля участия\s*\n/, /8\.\s*Место нахождения/));
  set("supplier_address", between(text, /8\.\s*Место нахождения/, /9\.\s*Дата постановки/));
  set("customer_name", between(text, /17\.1\s*Доля участия\s*\n/, /18\.\s*Место нахождения/));
  const buyerAddress = between(text, /18\.\s*Место нахождения/, /18\.1\s*Код страны/);
  set("customer_address", buyerAddress);
  // The consignee is the buyer in this form; its delivery address is the unloading point of the export documents.
  set("unloading_address", buyerAddress);

  set("contract_number", after(text, /27\.3\s*Номер/));
  set("contract_date", isoDate(after(text, /27\.4\s*Дата/)));
  set("incoterms", after(text, /31\.1\s*Условия поставки/));

  return { data, items: goodsRows(text) };
}

export const normalizeProductName = (value: string) => value.toLocaleUpperCase("ru-RU").replace(/Ё/g, "Е").replace(/[^\p{L}\p{N}]+/gu, "");
