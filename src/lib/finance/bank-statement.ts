// Bank statement in the 1С exchange format (1CClientBankExchange), as Kazakh banks — Freedom Bank among them —
// export it for 1С. The file is a list of key=value lines: a header with our accounts and the period, then one
// «СекцияДокумент» … «КонецДокумента» block per payment. Only incoming payments (to one of our accounts) are kept.
//
// Field names differ between banks and 1С versions (Russian «ИНН/Счет» vs Kazakh «БИН/ИИН/ИИК»), so each value is
// read from a list of variants. The real Freedom Bank file has not been seen yet: when it arrives, add its field
// names here and a test with an anonymised copy.

export type BankPayment = {
  operation_id?: string | null;
  identity_source?: "bank";
  recipient_account?: string;
  rowNumber?: number;
  doc_number: string | null;
  doc_date: string;
  amount: number;
  payer_name: string | null;
  payer_bin: string | null;
  payer_account: string | null;
  purpose: string | null;
};

export type ParsedStatement = {
  accounts: string[];
  periodFrom: string | null;
  periodTo: string | null;
  currency: string | null;
  documents: number;
  outgoing: number;
  incoming: BankPayment[];
  problems: string[];
};

const PAYER_BIN = ["ПлательщикБИН", "ПлательщикИИН", "ПлательщикБИН_ИИН", "ПлательщикБИНИИН", "ПлательщикИНН", "ПлательщикРНН"];
const PAYER_ACCOUNT = ["ПлательщикИИК", "ПлательщикСчет", "ПлательщикРасчСчет", "ПлательщикИБАН"];
const PAYER_NAME = ["Плательщик", "Плательщик1", "ПлательщикНаименование"];
const RECIPIENT_ACCOUNT = ["ПолучательИИК", "ПолучательСчет", "ПолучательРасчСчет", "ПолучательИБАН"];
const CURRENCY_BY_NUMBER: Record<string, string> = { "398": "KZT", "840": "USD", "978": "EUR", "643": "RUB", "156": "CNY" };
const MAX_PAYMENTS = 5000;

// 1С writes these files in Windows-1251 by default («Кодировка=Windows»), some banks in UTF-8.
export function decodeStatement(bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1251").decode(body);
  }
}

const normalizeAccount = (value: string | undefined) => (value ?? "").replace(/\s+/g, "").toUpperCase();

// 05.09.2026 → 2026-09-05; anything that is not a real date → null.
export function parseStatementDate(value: string | undefined): string | null {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec((value ?? "").trim());
  if (!match) return null;
  const [, day, month, year] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}

// «150000.00», «150 000,00», «150000» → 150000; at most two decimals, otherwise null.
export function parseStatementAmount(value: string | number | null | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) && Math.round(value * 100) / 100 === value ? value : null;
  const text = (value ?? "").replace(/[\s ]/g, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && Math.abs(amount) < 100000000000000 ? amount : null;
}

function pick(fields: Map<string, string>, names: string[]) {
  for (const name of names) {
    const value = fields.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

function purposeOf(fields: Map<string, string>) {
  const parts = [fields.get("НазначениеПлатежа")?.trim() ?? ""];
  for (let index = 1; fields.has(`НазначениеПлатежа${index}`); index++) parts.push(fields.get(`НазначениеПлатежа${index}`)!.trim());
  const text = parts.filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  return text || null;
}

export function parseBankStatement(source: string): ParsedStatement {
  const lines = source.split(/\r\n|\r|\n/);
  if (lines.find(line => line.trim())?.trim() !== "1CClientBankExchange") {
    throw new Error("Это не выписка в формате 1С: в начале файла нет строки «1CClientBankExchange».");
  }
  const header = new Map<string, string>();
  const accounts = new Set<string>();
  const documents: Map<string, string>[] = [];
  let current: Map<string, string> | null = null;
  let section: "document" | "account" | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("СекцияДокумент")) {
      if (current) throw new Error("Файл оборван: вложенная секция документа.");
      current = new Map(); section = "document"; continue;
    }
    if (line === "КонецДокумента") { if (current) documents.push(current); current = null; section = null; continue; }
    if (line === "СекцияРасчСчет") { section = "account"; continue; }
    if (line === "КонецРасчСчет") { section = null; continue; }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (section === "document" && current) { if (!current.has(key)) current.set(key, value); continue; }
    if (key === "РасчСчет" && value.trim()) accounts.add(normalizeAccount(value));
    if (!header.has(key)) header.set(key, value);
  }
  if (current) throw new Error("Файл оборван: последний документ не закрыт строкой «КонецДокумента».");
  if (!accounts.size || !lines.some(line => line.trim() === "КонецФайла")) throw new Error("Неполная выписка: нет счёта или строки «КонецФайла».");

  const problems: string[] = [];
  const currencies = new Set<string>();
  for (const fields of [header, ...documents]) {
    const raw = (fields.get("Валюта") ?? fields.get("КодВалюты") ?? "").trim().toUpperCase();
    if (raw) {
      const code = /^[A-Z]{3}$/.test(raw) ? raw : CURRENCY_BY_NUMBER[raw];
      if (code) currencies.add(code); else problems.push(`Неизвестная валюта: ${raw}`);
    }
  }
  if (currencies.size > 1) problems.push("Многовалютная выписка не поддерживается: выгрузите каждый счёт и валюту отдельно");
  const incoming: BankPayment[] = [];
  let outgoing = 0;
  documents.forEach((fields, index) => {
    const label = `Документ ${index + 1}${fields.get("Номер") ? ` (№ ${fields.get("Номер")!.trim()})` : ""}`;
    const recipient = normalizeAccount(pick(fields, RECIPIENT_ACCOUNT) ?? "");
    const payerAccount = normalizeAccount(pick(fields, PAYER_ACCOUNT) ?? "");
    const isIncoming = accounts.size
      ? accounts.has(recipient) && !accounts.has(payerAccount)
      : Boolean(fields.get("ДатаПоступило")?.trim()) && !fields.get("ДатаСписано")?.trim();
    if (!isIncoming) { outgoing++; return; }
    const date = parseStatementDate(fields.get("ДатаПоступило")) ?? parseStatementDate(fields.get("Дата"));
    const amount = parseStatementAmount(fields.get("Сумма"));
    if (!date) { problems.push(`${label}: нет даты или дата некорректна`); return; }
    if (amount === null || amount <= 0) { problems.push(`${label}: сумма некорректна`); return; }
    incoming.push({
      rowNumber: index + 1,
      recipient_account: recipient,
      operation_id: pick(fields, ["ИдентификаторОперации"]),
      identity_source: "bank",
      doc_number: fields.get("Номер")?.trim() || null,
      doc_date: date,
      amount,
      payer_name: pick(fields, PAYER_NAME),
      payer_bin: pick(fields, PAYER_BIN)?.replace(/\D/g, "") || null,
      payer_account: payerAccount || null,
      purpose: purposeOf(fields),
    });
  });
  if (incoming.length > MAX_PAYMENTS) throw new Error(`В одной выписке допускается не более ${MAX_PAYMENTS} поступлений.`);

  const currency = currencies.size === 1 ? [...currencies][0] : null;
  return {
    accounts: [...accounts],
    periodFrom: parseStatementDate(header.get("ДатаНачала")),
    periodTo: parseStatementDate(header.get("ДатаКонца")),
    currency,
    documents: documents.length,
    outgoing,
    incoming,
    problems,
  };
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

// Checks what the browser sent before it reaches the database.
export function normalizeBankPayments(value: unknown): BankPayment[] {
  if (!Array.isArray(value)) throw new Error("Некорректный список платежей");
  if (value.length > MAX_PAYMENTS) throw new Error(`В одной выписке допускается не более ${MAX_PAYMENTS} поступлений.`);
  return value.map((row, index) => {
    const record = (row ?? {}) as Record<string, unknown>;
    const date = typeof record.doc_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.doc_date) ? record.doc_date : null;
    const amount = parseStatementAmount(typeof record.amount === "number" ? record.amount : null);
    if (!date || amount === null || amount <= 0) throw new Error(`Платёж ${index + 1}: некорректная дата или сумма`);
    return {
      doc_number: text(record.doc_number, 64), doc_date: date, amount,
      payer_name: text(record.payer_name, 500), payer_bin: text(record.payer_bin, 32)?.replace(/\D/g, "") || null,
      payer_account: text(record.payer_account, 64), purpose: text(record.purpose, 2000),
    };
  });
}
