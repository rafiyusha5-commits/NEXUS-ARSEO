// Pure normalisation of reference-import values (text, numbers, codes, dictionaries).
// Shared by the browser preview and the Server Action; the database re-checks everything.

export type Cell = string | number | boolean | Date | null | undefined;

// A value that can not be normalised; the message is shown to the user as is.
export class NormalizeError extends Error {}

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const SPACES = /[\s   ]+/g;

// Trims, removes invisible characters and collapses whitespace. Numbers become plain
// strings (Excel stores SKUs and codes as numbers), dates become YYYY-MM-DD.
export function cleanText(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (value instanceof Date) text = Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  else if (typeof value === "number") text = Number.isFinite(value) ? String(value) : "";
  else text = String(value);
  return text.normalize("NFC").replace(ZERO_WIDTH, "").replace(CONTROL, "").replace(SPACES, " ").trim();
}

// Text or null for empty values; longer than max characters is an error.
export function optionalText(value: unknown, max: number, label: string): string | null {
  const text = cleanText(value);
  if (!text) return null;
  if (text.length > max) throw new NormalizeError(`${label}: не длиннее ${max} символов`);
  return text;
}

// Lower-case key for dictionary look-ups and header matching.
export function normalizeKey(value: unknown): string {
  return cleanText(value).toLocaleLowerCase("ru-RU").replace(/ё/g, "е");
}

// "Срок годности, дней" -> "срок_годности_дней"; "BIN/ИНН" -> "bin_инн".
export function normalizeHeader(value: unknown): string {
  return normalizeKey(value).replace(/[^a-z0-9а-яәғқңөұүһі]+/g, "_").replace(/^_+|_+$/g, "");
}

type DecimalOptions = { scale: number; max?: number; positive?: boolean; label: string };

// Parses "1 200,5", "1.200,50", "1,200.5", "12,5", 12.5. With a single separator and no
// other, "," and "." are both decimal marks; repeated identical separators are thousands.
export function parseDecimal(value: unknown, options: DecimalOptions): number | null {
  const { scale, max = Number.MAX_SAFE_INTEGER, positive = false, label } = options;
  let number: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new NormalizeError(`${label}: не число`);
    number = value;
  } else {
    let text = cleanText(value).replace(/[\s']/g, "");
    if (!text) return null;
    const commas = (text.match(/,/g) ?? []).length;
    const dots = (text.match(/\./g) ?? []).length;
    if (commas && dots) {
      const decimal = text.lastIndexOf(",") > text.lastIndexOf(".") ? "," : ".";
      const thousands = decimal === "," ? "." : ",";
      if ((decimal === "," ? commas : dots) > 1) throw new NormalizeError(`${label}: непонятный формат числа «${cleanText(value)}»`);
      text = text.split(thousands).join("").replace(decimal, ".");
    } else if (commas > 1 || dots > 1) {
      text = text.replace(/[.,]/g, "");
    } else {
      text = text.replace(",", ".");
    }
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new NormalizeError(`${label}: «${cleanText(value)}» — не число`);
    number = Number(text);
  }
  if (number < 0 || (positive && number === 0)) {
    throw new NormalizeError(`${label}: должно быть ${positive ? "больше нуля" : "не меньше нуля"}`);
  }
  const factor = 10 ** scale;
  const rounded = Math.round(number * factor) / factor;
  if (Math.abs(rounded - number) > 1e-9 * Math.max(1, Math.abs(number))) {
    throw new NormalizeError(`${label}: не больше ${scale} знаков после запятой`);
  }
  if (rounded >= max) throw new NormalizeError(`${label}: слишком большое значение`);
  return rounded;
}

export function parseInteger(value: unknown, options: { min: number; max: number; label: string }): number | null {
  const number = parseDecimal(value, { scale: 0, label: options.label });
  if (number === null) return null;
  if (number < options.min || number > options.max) {
    throw new NormalizeError(`${options.label}: от ${options.min} до ${options.max}`);
  }
  return number;
}

const TRUE_WORDS = new Set(["1", "true", "yes", "y", "да", "д", "+", "истина", "нужно", "нужна", "требуется"]);
const FALSE_WORDS = new Set(["0", "false", "no", "n", "нет", "н", "-", "ложь", "не нужно", "не нужна", "не требуется"]);

export function parseBoolean(value: unknown, label: string): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && (value === 0 || value === 1)) return value === 1;
  const key = normalizeKey(value);
  if (!key) return null;
  if (TRUE_WORDS.has(key)) return true;
  if (FALSE_WORDS.has(key)) return false;
  throw new NormalizeError(`${label}: ожидается «да» или «нет», получено «${cleanText(value)}»`);
}

export function normalizeCountry(value: unknown, label: string): string | null {
  const text = cleanText(value).toUpperCase();
  if (!text) return null;
  if (!/^[A-Z]{2}$/.test(text)) throw new NormalizeError(`${label}: двухбуквенный код ISO (KZ, FI), получено «${cleanText(value)}»`);
  return text;
}

// ТН ВЭД: 4–10 digits, even length. Excel drops the leading zero of chapters 01–09 when
// the code is stored as a number, so an odd-length number gets it back.
export function normalizeHsCode(value: unknown, label: string): string | null {
  let digits = typeof value === "number" ? String(value) : cleanText(value).replace(/[\s.\-]/g, "");
  if (!digits) return null;
  if (!/^\d+$/.test(digits)) throw new NormalizeError(`${label}: только цифры, получено «${cleanText(value)}»`);
  if (typeof value === "number" && digits.length % 2 === 1) digits = `0${digits}`;
  if (digits.length < 4 || digits.length > 10 || digits.length % 2 === 1) {
    throw new NormalizeError(`${label}: 4, 6, 8 или 10 цифр (если потерян ведущий ноль — добавьте его), получено «${cleanText(value)}»`);
  }
  return digits;
}

// GS1 check digit for GTIN-8/12/13/14.
export function isValidGtin(value: string): boolean {
  if (!/^\d+$/.test(value) || ![8, 12, 13, 14].includes(value.length)) return false;
  let sum = 0;
  for (let i = 1; i < value.length; i += 1) {
    sum += Number(value[value.length - 1 - i]) * (i % 2 === 1 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(value[value.length - 1]);
}

// Same comparison key as private.barcode_key(): numeric codes as GTIN-14.
export function barcodeKey(value: string): string {
  const text = value.trim();
  return /^\d{1,14}$/.test(text) ? text.padStart(14, "0") : text.toUpperCase();
}

function barcodeDigits(value: unknown, label: string): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new NormalizeError(`${label}: «${value}» — не штрихкод`);
    return String(value);
  }
  return cleanText(value).replace(/[\s\-]/g, "");
}

export function normalizeGtin(value: unknown, label = "GTIN"): string | null {
  const digits = barcodeDigits(value, label);
  if (!digits) return null;
  if (!isValidGtin(digits)) {
    throw new NormalizeError(`${label}: ${digits} — нужно 8, 12, 13 или 14 цифр с верной контрольной цифрой`);
  }
  return digits;
}

export function normalizeBarcode(value: unknown, label: string): string | null {
  const text = typeof value === "number" ? barcodeDigits(value, label) : cleanText(value).replace(/\s/g, "");
  if (!text) return null;
  if (!/^[0-9A-Za-z-]{4,48}$/.test(text)) {
    throw new NormalizeError(`${label}: от 4 до 48 латинских букв, цифр или дефисов, получено «${cleanText(value)}»`);
  }
  return text;
}

function dictionary<T extends string>(entries: Record<T, string[]>) {
  const map = new Map<string, T>();
  for (const [code, words] of Object.entries(entries) as [T, string[]][]) {
    map.set(code, code);
    for (const word of words) map.set(normalizeKey(word), code);
  }
  return map;
}

export const COUNTERPARTY_ROLES = ["manufacturer", "supplier", "customer", "carrier", "broker", "printing_house", "other"] as const;
export type CounterpartyRole = (typeof COUNTERPARTY_ROLES)[number];
const ROLE_WORDS = dictionary<CounterpartyRole>({
  manufacturer: ["производитель", "изготовитель"],
  supplier: ["поставщик"],
  customer: ["клиент", "покупатель"],
  carrier: ["перевозчик"],
  broker: ["брокер", "таможенный брокер"],
  printing_house: ["типография", "printing house"],
  other: ["другое", "прочее"],
});

// "производитель | поставщик", ["supplier"] -> ["manufacturer", "supplier"].
export function normalizeRoles(value: unknown, label: string): CounterpartyRole[] {
  const parts = Array.isArray(value) ? value : cleanText(value).split(/[|,;/]+/);
  const roles: CounterpartyRole[] = [];
  for (const part of parts) {
    const key = normalizeKey(part);
    if (!key) continue;
    const role = ROLE_WORDS.get(key);
    if (!role) throw new NormalizeError(`${label}: неизвестная роль «${cleanText(part)}»`);
    if (!roles.includes(role)) roles.push(role);
  }
  if (!roles.length) throw new NormalizeError(`${label}: укажите хотя бы одну роль`);
  return roles;
}

export const UOMS = ["piece", "box", "layer", "pallet", "truck"] as const;
export type Uom = (typeof UOMS)[number];
const UOM_WORDS = dictionary<Uom>({
  piece: ["шт", "шт.", "штука", "ед", "единица", "pcs", "pc", "unit", "ea"],
  box: ["короб", "коробка", "кор", "кор.", "ящик", "case", "carton"],
  layer: ["слой", "ряд"],
  pallet: ["паллета", "палета", "паллет", "поддон", "pal"],
  truck: ["фура", "машина", "грузовик"],
});

export function normalizeUom(value: unknown, label: string): Uom | null {
  const key = normalizeKey(value);
  if (!key) return null;
  const uom = UOM_WORDS.get(key);
  if (!uom) throw new NormalizeError(`${label}: неизвестный уровень упаковки «${cleanText(value)}»`);
  return uom;
}

export const TEMPERATURE_REGIMES = ["frozen", "chilled", "ambient"] as const;
export type TemperatureRegime = (typeof TEMPERATURE_REGIMES)[number];
const REGIME_WORDS = dictionary<TemperatureRegime>({
  frozen: ["заморозка", "замороженный", "замороженная", "мороз"],
  chilled: ["охлажденный", "охлажденная", "охлаждение", "холод", "холодильник"],
  ambient: ["комнатная", "комнатный", "обычный", "обычная", "сухой", "без режима"],
});

export function normalizeTemperatureRegime(value: unknown, label: string): TemperatureRegime | null {
  const key = normalizeKey(value);
  if (!key) return null;
  const regime = REGIME_WORDS.get(key);
  if (!regime) throw new NormalizeError(`${label}: frozen, chilled или ambient, получено «${cleanText(value)}»`);
  return regime;
}

function signed(value: number): string {
  const text = String(value).replace(".", ",");
  return value > 0 ? `+${text}` : text;
}

// Temperature limits in °C -> "+2…+6 °C", "от −18 °C", "до +25 °C".
export function formatTemperatureRange(min: number | null, max: number | null): string | null {
  if (min !== null && max !== null) {
    if (min > max) throw new NormalizeError("Температура: нижняя граница больше верхней");
    return `${signed(min)}…${signed(max)} °C`;
  }
  if (min !== null) return `от ${signed(min)} °C`;
  if (max !== null) return `до ${signed(max)} °C`;
  return null;
}

// Temperatures may be negative, unlike every other number of the format.
export function parseTemperature(value: unknown, label: string): number | null {
  const text = typeof value === "number" ? value : cleanText(value).replace(/[−–]/g, "-").replace(/\s*°?\s*[cс]$/i, "");
  if (text === "") return null;
  const negative = typeof text === "number" ? text < 0 : text.startsWith("-");
  const magnitude = parseDecimal(typeof text === "number" ? Math.abs(text) : text.replace(/^[-+]/, ""), { scale: 1, max: 100, label });
  if (magnitude === null) return null;
  return negative ? -magnitude : magnitude;
}

export const NUTRITION_BASES = ["100g", "100ml", "serving"] as const;
export type NutritionBasis = (typeof NUTRITION_BASES)[number];
const BASIS_WORDS = dictionary<NutritionBasis>({
  "100g": ["100 г", "100г", "на 100 г", "100 g"],
  "100ml": ["100 мл", "100мл", "на 100 мл", "100 ml"],
  serving: ["порция", "на порцию"],
});

export function normalizeNutritionBasis(value: unknown, label: string): NutritionBasis | null {
  const key = normalizeKey(value);
  if (!key) return null;
  const basis = BASIS_WORDS.get(key);
  if (!basis) throw new NormalizeError(`${label}: 100g, 100ml или serving, получено «${cleanText(value)}»`);
  return basis;
}

export const LOCALES = ["ru", "kk", "en"] as const;
export type Locale = (typeof LOCALES)[number];

export function normalizeLocale(value: unknown, label: string): Locale | null {
  const key = normalizeKey(value);
  if (!key) return null;
  const locale = key === "kz" ? "kk" : key;
  if (!(LOCALES as readonly string[]).includes(locale)) throw new NormalizeError(`${label}: ru, kk или en`);
  return locale as Locale;
}

export const PRODUCT_STATUSES = ["draft", "active", "discontinued"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
const STATUS_WORDS = dictionary<ProductStatus>({
  draft: ["черновик"],
  active: ["активен", "активный", "действует"],
  discontinued: ["снят", "выведен", "снят с производства"],
});

export function normalizeProductStatus(value: unknown, label: string): ProductStatus | null {
  const key = normalizeKey(value);
  if (!key) return null;
  const status = STATUS_WORDS.get(key);
  if (!status) throw new NormalizeError(`${label}: draft, active или discontinued`);
  return status;
}

// Column or key names that look like prices or commercial terms. Such data must never be
// part of the reference import, so these names are rejected with a dedicated message.
const COMMERCIAL = /(price|cost|margin|markup|discount|rebate|bonus|contract|payment|incoterm|currency|контракт|цен[аыу]|себестоим|марж|наценк|скидк|бонус|договор|оплат|валют|услови)/i;

export function looksCommercial(name: string): boolean {
  return COMMERCIAL.test(name);
}
