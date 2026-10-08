// Masks identity documents, personal numbers, phones and secrets before any text leaves the server
// (model request, trace, error). Masking is code, not an instruction to the model.

type Rule = { pattern: RegExp; replace: string | ((match: string, ...groups: string[]) => string) };

const KEYWORD_ID =
  /((?:удостоверени\p{L}*|уд\.\s?л\.|паспорт\p{L}*|passport|ИИН|IIN|ID[- ]?card|документ\p{L}*\s+водител\p{L}*)\s*(?:№|N|#|:|-)?\s*)([\p{L}\p{N}][\p{L}\p{N} -]{3,24}[\p{L}\p{N}])/giu;

const SECRET_RULES: Rule[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, replace: "[скрыт ключ]" },
  { pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@]+@/gi, replace: "[скрыт адрес с паролем]@" },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, replace: "Bearer [скрыт токен]" },
  { pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, replace: "[скрыт токен]" },
  { pattern: /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, replace: "[скрыт ключ]" },
  { pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: "[скрыт ключ]" },
  {
    pattern: /\b(password|passwd|пароль|token|токен|secret|секрет|api[_ -]?key|ключ\s+api|private[_ -]?key)(\s*[:=]\s*)(\S+)/gi,
    replace: (_m, key: string, sep: string) => `${key}${sep}[скрыто]`,
  },
  { pattern: /\b[0-9a-f]{32,}\b/gi, replace: "[скрыто]" },
  { pattern: /\b[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/=])/g, replace: "[скрыто]" },
];

const PERSONAL_RULES: Rule[] = [
  { pattern: KEYWORD_ID, replace: (_m, prefix: string) => `${prefix}[скрыт номер документа]` },
  // The same numbers written with spaces or hyphens: 12 digits as 6+6 or 3+3+3+3, 9 digits as 3+3+3.
  { pattern: /(?<!\p{N}[ -]?)\d{6}[ -]\d{6}(?![ -]?\p{N})|(?<!\p{N}[ -]?)\d{3}(?:[ -]\d{3}){3}(?![ -]?\p{N})/gu, replace: "[скрыт ИИН]" },
  { pattern: /(?<!\p{N}[ -]?)\d{3}[ -]\d{3}[ -]\d{3}(?![ -]?\p{N})/gu, replace: "[скрыт номер документа]" },
  // Kazakhstan IIN/BIN: exactly 12 digits.
  { pattern: /(?<![\p{N}\p{L}])\d{12}(?![\p{N}\p{L}])/gu, replace: "[скрыт ИИН]" },
  // Passport-like: 1–2 letters followed by 7–9 digits.
  { pattern: /(?<![\p{N}\p{L}])[A-ZА-ЯЁ]{1,2}\s?\d{7,9}(?![\p{N}\p{L}])/gu, replace: "[скрыт номер документа]" },
  // Kazakhstan ID card: exactly 9 digits.
  { pattern: /(?<![\p{N}\p{L}])\d{9}(?![\p{N}\p{L}])/gu, replace: "[скрыт номер документа]" },
  // Phone numbers: +7 / 8 / international with at least 10 digits.
  { pattern: /(?<![\p{N}\p{L}])(?:\+\d{1,3}[\s()-]*|8[\s()-]*)\d{3}[\s()-]*\d{3}[\s()-]*\d{2}[\s()-]*\d{2}(?![\p{N}\p{L}])/gu, replace: "[скрыт телефон]" },
];

// Money in free text: a number with a currency marker. Applied to Nexus data only.
const MONEY_RULE: Rule = {
  pattern: /(?:(?:€|\$|₸|₽)\s?\d[\d\s.,]*\d|\d[\d\s.,]*\s?(?:€|\$|₸|₽|EUR|USD|KZT|RUB|евро|долл\p{L}*|тенге|тг\.?|руб\p{L}*\.?))(?![\p{L}])/giu,
  replace: "[скрыта сумма]",
};

// Zero-width and bidi control characters can hide instructions in text that looks harmless.
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

export type MaskResult = { text: string; masked: number };

function applyRules(text: string, rules: Rule[]): MaskResult {
  let masked = 0;
  let current = text;
  for (const rule of rules) {
    current = current.replace(rule.pattern, (...args: string[]) => {
      masked += 1;
      return typeof rule.replace === "string" ? rule.replace : rule.replace(args[0], ...args.slice(1));
    });
  }
  return { text: current, masked };
}

/** Masks secrets and personal document numbers. Used for the user's question and all outgoing text. */
export function maskSensitive(text: string): MaskResult {
  const clean = text.normalize("NFC").replace(INVISIBLE, "");
  const secrets = applyRules(clean, SECRET_RULES);
  const personal = applyRules(secrets.text, PERSONAL_RULES);
  return { text: personal.text, masked: secrets.masked + personal.masked };
}

/**
 * Free text taken from Nexus (titles, reasons, comments). Also masks money. When a long digit
 * run survives masking it may be an unknown identifier, so the text is withheld entirely.
 */
export function maskDataText(text: string | null | undefined, maxLength = 200): string | null {
  if (text == null) return null;
  const first = maskSensitive(String(text));
  const money = applyRules(first.text, [MONEY_RULE]);
  const value = money.text.replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/\d{7,}/.test(value.replace(/[\s-]/g, "").replace(/\[[^\]]*\]/g, ""))) return "[текст скрыт: возможны персональные данные]";
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export type QuestionCheck = { ok: true; text: string; masked: number } | { ok: false; code: "QUESTION_EMPTY" | "QUESTION_TOO_LONG" | "QUESTION_UNSAFE" };

export const MAX_QUESTION_LENGTH = 1000;

/** The original question is never stored or sent; only this masked version is. */
export function prepareQuestion(raw: unknown): QuestionCheck {
  if (typeof raw !== "string") return { ok: false, code: "QUESTION_EMPTY" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, code: "QUESTION_EMPTY" };
  if (trimmed.length > MAX_QUESTION_LENGTH) return { ok: false, code: "QUESTION_TOO_LONG" };
  const { text, masked } = maskSensitive(trimmed);
  // A question that is mostly masked material cannot be cleaned safely: do not send it.
  if (masked > 5 || /PRIVATE KEY/i.test(trimmed)) return { ok: false, code: "QUESTION_UNSAFE" };
  return { ok: true, text, masked };
}

/** Short masked excerpt for the trace (database limit 200 characters). */
export function traceExcerpt(maskedQuestion: string): string {
  const flat = maskedQuestion.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}
