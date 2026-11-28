// GS1 element strings (GS1-128, GS1 DataMatrix, GS1 QR) as scanners and cameras deliver them: with a symbology
// identifier (]C1, ]d2, ]Q3) and GS (\u001d) after variable fields, or in the human-readable form with brackets.
// Only what warehouse work needs is read: (01) GTIN, (10) batch, (17) expiry, (37) quantity, (21) serial. A marking
// DataMatrix (with 91/92) is read the same way and used only as the product by its GTIN.

const GS = "\u001d";
/** Fixed lengths of the data of AIs (without the AI); the other known AIs are variable with a maximum. */
const FIXED: Record<string, number> = { "00": 18, "01": 14, "02": 14, "11": 6, "12": 6, "13": 6, "15": 6, "16": 6, "17": 6, "20": 2 };
const VARIABLE: Record<string, number> = { "10": 20, "21": 20, "22": 20, "30": 8, "37": 8, "240": 30, "241": 30, "250": 30, "251": 30, "400": 30,
  "90": 30, "91": 90, "92": 90, "93": 90, "94": 90, "95": 90, "96": 90, "97": 90, "98": 90, "99": 90 };

export type Gs1Result =
  | { ok: true; gtin: string | null; batch: string | null; expiry: string | null; quantity: number | null; serial: string | null; fields: Record<string, string> }
  | { ok: false; error: "not_gs1" | "unknown_ai" | "bad_length" | "bad_gtin" | "bad_date" | "bad_quantity" };

/** Is this a GS1 element string rather than a plain barcode (EAN-13, a Nexus label)? */
export function looksLikeGs1(raw: string) {
  const value = raw.trim();
  return /^\](C1|d2|Q3|e0)/.test(value) || /^\(\d{2,4}\)/.test(value) || (value.includes(GS) && /^\d{2}/.test(value))
    || /^01\d{14}(1[0-7]|2[01]|3[07]|9[1-9])/.test(value);
}

export function gtinValid(gtin: string) {
  if (!/^\d{8}$|^\d{12,14}$/.test(gtin)) return false;
  const digits = gtin.padStart(14, "0").split("").map(Number);
  const sum = digits.slice(0, 13).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === digits[13];
}

/** YYMMDD -> YYYY-MM-DD; DD 00 means the last day of the month; the century by the GS1 rule (from 49 years back). */
export function gs1Date(value: string, today = new Date()): string | null {
  if (!/^\d{6}$/.test(value)) return null;
  const yy = Number(value.slice(0, 2)), mm = Number(value.slice(2, 4)), dd = Number(value.slice(4, 6));
  if (mm < 1 || mm > 12) return null;
  const current = today.getUTCFullYear(), century = Math.floor(current / 100) * 100;
  let year = century + yy;
  if (year - current >= 51) year -= 100;
  else if (current - year > 49) year += 100;
  const last = new Date(Date.UTC(year, mm, 0)).getUTCDate();
  const day = dd === 0 ? last : dd;
  if (day > last) return null;
  return `${year}-${String(mm).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function aiAt(data: string, index: number): string | null {
  for (const length of [2, 3, 4]) {
    const ai = data.slice(index, index + length);
    if (FIXED[ai] !== undefined || VARIABLE[ai] !== undefined) return ai;
    // 310n–369n: measures with 6 fixed digits.
    if (length === 4 && /^3[1-6]\d\d$/.test(ai)) return ai;
  }
  return null;
}

export function parseGs1(raw: string, today = new Date()): Gs1Result {
  let value = raw.replace(/\r|\n/g, "").trim();
  if (!looksLikeGs1(value)) return { ok: false, error: "not_gs1" };
  value = value.replace(/^\](C1|d2|Q3|e0)/, "");
  const fields: Record<string, string> = {};
  if (value.startsWith("(")) {
    for (const match of value.matchAll(/\((\d{2,4})\)([^(]*)/g)) {
      const [, ai, data] = match;
      if (FIXED[ai] === undefined && VARIABLE[ai] === undefined && !/^3[1-6]\d\d$/.test(ai)) return { ok: false, error: "unknown_ai" };
      fields[ai] = data;
    }
  } else {
    let index = 0;
    while (index < value.length) {
      if (value[index] === GS) { index += 1; continue; }
      const ai = aiAt(value, index);
      if (!ai) return { ok: false, error: "unknown_ai" };
      index += ai.length;
      const fixed = FIXED[ai] ?? (/^3[1-6]\d\d$/.test(ai) ? 6 : undefined);
      if (fixed !== undefined) {
        fields[ai] = value.slice(index, index + fixed);
        index += fixed;
      } else {
        const end = value.indexOf(GS, index);
        fields[ai] = value.slice(index, end < 0 ? value.length : end);
        index = end < 0 ? value.length : end + 1;
      }
    }
  }
  for (const [ai, data] of Object.entries(fields)) {
    const fixed = FIXED[ai] ?? (/^3[1-6]\d\d$/.test(ai) ? 6 : undefined);
    if (fixed !== undefined ? data.length !== fixed : data.length < 1 || data.length > VARIABLE[ai]) return { ok: false, error: "bad_length" };
  }
  const gtin = fields["01"] ?? fields["02"] ?? null;
  if (gtin && !gtinValid(gtin)) return { ok: false, error: "bad_gtin" };
  const expiry = fields["17"] ? gs1Date(fields["17"], today) : null;
  if (fields["17"] && !expiry) return { ok: false, error: "bad_date" };
  const quantityText = fields["37"] ?? fields["30"];
  if (quantityText && !/^\d{1,8}$/.test(quantityText)) return { ok: false, error: "bad_quantity" };
  return { ok: true, gtin, batch: fields["10"] ?? null, expiry, quantity: quantityText ? Number(quantityText) : null, serial: fields["21"] ?? null, fields };
}

export const gs1ErrorText: Record<Exclude<Gs1Result, { ok: true }>["error"], string> = {
  not_gs1: "Это не код GS1",
  unknown_ai: "В коде GS1 есть неизвестный идентификатор применения",
  bad_length: "Поле кода GS1 неверной длины",
  bad_gtin: "Неверная контрольная цифра GTIN",
  bad_date: "Неверная дата в коде GS1",
  bad_quantity: "Неверное количество в коде GS1",
};
