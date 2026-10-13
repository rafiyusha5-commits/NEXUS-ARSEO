// Opening balances from the 1С report on settlements with customers («Ведомость по взаиморасчётам с
// контрагентами», «Оборотно-сальдовая ведомость по счёту 1210»), saved as XLSX or CSV.
//
// The table is found by its header: a counterparty column and either one balance column or a debit/credit pair.
// When the report has several debit/credit pairs (opening, turnover, closing), the closing pair is used — the one
// whose header (or the merged header above it) mentions the end of the period, else the last pair. Rows with
// totals are skipped. The real report has not been seen yet: when it arrives, adjust the aliases and add a test.

import { parseStatementAmount } from "./bank-statement.ts";

export type Cell = string | number | boolean | Date | null;
export type OpeningRow = {
  rowNumber: number;
  name: string;
  bin: string | null;
  contract: string | null;
  currency: string;
  amount: number;
  due_date: string | null;
};
export type ParsedOpening = { rows: OpeningRow[]; problems: string[] };

const MAX_ROWS = 2000;
const normalize = (value: Cell) => String(value ?? "").trim().toLocaleLowerCase("ru-RU").replace(/ё/g, "е").replace(/\s+/g, " ");
const textOf = (value: Cell) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").trim();
const isName = (header: string) => /^(контрагент|покупател|наименовани|клиент)/.test(header) && !/бин|иин|инн/.test(header);
const isNameHeader = (header: string) => isName(header) && header.length <= 40;
const isBin = (header: string) => /(^|[^а-я])(бин|иин|инн)([^а-я]|$)/.test(header);
const isEnd = (label: string) => /конец|конеч|на \d{2}\.\d{2}\.\d{4}\s*$/.test(label);

function amountOf(value: Cell): number | null {
  if (value === null || value === "" || value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
  const cleaned = String(value).replace(/[\s ]/g, "");
  if (!cleaned) return 0;
  return parseStatementAmount(cleaned);
}

function dateOf(value: Cell): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const textValue = textOf(value);
  const dotted = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(textValue);
  if (dotted) return `${dotted[3]}-${dotted[2]}-${dotted[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(textValue) ? textValue : null;
}

export function parseOpeningBalances(matrix: Cell[][], defaultCurrency = "KZT"): ParsedOpening {
  const nameRow = matrix.slice(0, 30).findIndex(row => row.some(cell => isNameHeader(normalize(cell))));
  if (nameRow < 0) throw new Error("Не найдена строка заголовков: нужна колонка «Контрагент» (или «Покупатель»).");
  // 1С puts «Дебет»/«Кредит» either in the same row as «Контрагент» (under merged period labels above it) or in
  // the row below it. Each column's header is the lower label, the merged label above is kept for the period.
  const hasPairs = (row: Cell[] | undefined) => (row ?? []).some(cell => /дебет|кредит/.test(normalize(cell)));
  const split = !hasPairs(matrix[nameRow]) && hasPairs(matrix[nameRow + 1]);
  const top = split ? matrix[nameRow] : matrix[nameRow - 1] ?? [];
  const sub = split ? matrix[nameRow + 1] : matrix[nameRow];
  const header = Array.from({ length: Math.max(top.length, sub.length) }, (_, index) => normalize(sub[index] ?? null) || (split ? normalize(top[index] ?? null) : ""));
  const above: string[] = [];
  top.forEach((cell, index) => { above[index] = normalize(cell) || (index > 0 ? above[index - 1] : ""); });
  const label = (index: number) => `${above[index] ?? ""} ${header[index] ?? ""}`.trim();
  const find = (test: (value: string) => boolean) => header.findIndex(test);
  const dataStart = nameRow + (split ? 2 : 1);

  const nameColumn = find(isName);
  const binColumn = find(isBin);
  const contractColumn = find(value => value.includes("договор"));
  const currencyColumn = find(value => value.includes("валюта"));
  const dueColumn = find(value => value.includes("срок"));
  const balanceColumn = find(value => /^(сальдо|остаток|задолженность|долг)/.test(value) && !/дебет|кредит/.test(value));
  const debits = header.map((value, index) => value.includes("дебет") ? index : -1).filter(index => index >= 0);
  const credits = header.map((value, index) => value.includes("кредит") ? index : -1).filter(index => index >= 0);
  const endDebit = debits.find(index => isEnd(label(index))) ?? debits.at(-1);
  const endCredit = credits.find(index => isEnd(label(index))) ?? credits.at(-1);
  if (balanceColumn < 0 && endDebit === undefined && endCredit === undefined) {
    throw new Error("Не найдены колонки с суммой: «Сальдо» или «Дебет»/«Кредит».");
  }

  const rows: OpeningRow[] = [];
  const problems: string[] = [];
  matrix.slice(dataStart).forEach((row, offset) => {
    const rowNumber = dataStart + offset + 1;
    const name = textOf(row[nameColumn] ?? null);
    if (!name || /^(итого|всего)/i.test(name)) return;
    let amount: number | null;
    if (balanceColumn >= 0) amount = amountOf(row[balanceColumn] ?? null);
    else {
      const debit = endDebit === undefined ? 0 : amountOf(row[endDebit] ?? null);
      const credit = endCredit === undefined ? 0 : amountOf(row[endCredit] ?? null);
      amount = debit === null || credit === null ? null : Math.round((debit - credit) * 100) / 100;
    }
    if (amount === null) { problems.push(`Строка ${rowNumber}: сумма не распознана`); return; }
    const currency = (currencyColumn >= 0 ? textOf(row[currencyColumn] ?? null).toUpperCase() : "") || defaultCurrency;
    const normalizedCurrency = currency === "ТГ" || currency === "ТЕНГЕ" || currency === "KZT" ? "KZT" : currency;
    if (!/^[A-Z]{3}$/.test(normalizedCurrency)) { problems.push(`Строка ${rowNumber}: валюта «${currency}» не распознана`); return; }
    rows.push({
      rowNumber, name,
      bin: binColumn >= 0 ? textOf(row[binColumn] ?? null).replace(/\D/g, "") || null : null,
      contract: contractColumn >= 0 ? textOf(row[contractColumn] ?? null) || null : null,
      currency: normalizedCurrency, amount,
      due_date: dueColumn >= 0 ? dateOf(row[dueColumn] ?? null) : null,
    });
  });
  if (rows.length > MAX_ROWS) throw new Error(`В одном отчёте допускается не более ${MAX_ROWS} строк.`);
  return { rows, problems };
}

// CSV saved from 1С or Excel. The separator is the one found most in the first line: Russian Excel uses «;»
// because the comma is the decimal separator.
export function parseCsv(source: string): Cell[][] {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const separator = [";", "\t", ","].map(char => ({ char, count: firstLine.split(char).length - 1 }))
    .sort((left, right) => right.count - left.count)[0];
  const delimiter = separator.count > 0 ? separator.char : ";";
  const rows: Cell[][] = []; let row: string[] = []; let cell = ""; let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '"') { if (quoted && source[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; }
    else if (char === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && source[i + 1] === "\n") i++;
      row.push(cell); if (row.some(value => value.trim())) rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  row.push(cell); if (row.some(value => value.trim())) rows.push(row);
  return rows;
}

const text = (value: unknown, max: number) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;

// Checks what the browser sent before it reaches the database.
export function normalizeOpeningRows(value: unknown) {
  if (!Array.isArray(value) || !value.length) throw new Error("В отчёте нет строк");
  if (value.length > MAX_ROWS) throw new Error(`В одном отчёте допускается не более ${MAX_ROWS} строк.`);
  return value.map((row, index) => {
    const record = (row ?? {}) as Record<string, unknown>;
    const amount = typeof record.amount === "number" && Number.isFinite(record.amount) ? Math.round(record.amount * 100) / 100 : null;
    const currency = typeof record.currency === "string" && /^[A-Z]{3}$/.test(record.currency) ? record.currency : null;
    const due = typeof record.due_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(record.due_date) ? record.due_date : null;
    if (amount === null || !currency) throw new Error(`Строка ${index + 1}: некорректная сумма или валюта`);
    return { name: text(record.name, 500), bin: text(record.bin, 32), contract: text(record.contract, 200), currency, amount, due_date: due };
  });
}
