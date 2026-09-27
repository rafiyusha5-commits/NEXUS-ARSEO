// The reference-import package (format "nexus-reference-import", version 1) and its
// normalisation from JSON. public.import_reference_data() accepts exactly this shape.

import {
  type CounterpartyRole,
  type Locale,
  type NutritionBasis,
  type ProductStatus,
  type TemperatureRegime,
  type Uom,
  NormalizeError,
  cleanText,
  formatTemperatureRange,
  looksCommercial,
  normalizeBarcode,
  normalizeCountry,
  normalizeGtin,
  normalizeHsCode,
  normalizeLocale,
  normalizeNutritionBasis,
  normalizeProductStatus,
  normalizeRoles,
  normalizeTemperatureRegime,
  normalizeUom,
  optionalText,
  parseBoolean,
  parseDecimal,
  parseInteger,
  parseTemperature,
} from "./normalize.ts";

export const IMPORT_FORMAT = "nexus-reference-import";
export const IMPORT_VERSION = 1;
export const MAX_COUNTERPARTIES = 1000;
export const MAX_PRODUCTS = 1000;
export const MAX_IDENTIFIERS_PER_PRODUCT = 20;
export const MAX_PACKAGING_PER_PRODUCT = 5;

export type Localized = Partial<Record<Locale, string>>;
export const IDENTIFIER_TYPES = ["gtin", "unit_barcode", "box_barcode", "supplier_sku"] as const;
export type IdentifierType = (typeof IDENTIFIER_TYPES)[number];
export const NUTRITION_AMOUNTS = [
  "energy_kcal", "energy_kj", "protein_g", "fat_g", "saturated_fat_g", "carbohydrates_g", "sugars_g", "fiber_g", "salt_g",
] as const;
export type NutritionFacts = { basis?: NutritionBasis } & Partial<Record<(typeof NUTRITION_AMOUNTS)[number], number>>;

export type ImportCounterparty = {
  row: number;
  ref?: string;
  legal_name: string;
  short_name?: string;
  roles: CounterpartyRole[];
  country: string;
  tax_id?: string;
  registration_number?: string;
  website?: string;
  preferred_locale?: Locale;
};

export type ImportIdentifier = {
  type: IdentifierType;
  value: string;
  counterparty?: string;
  packaging_uom?: Uom;
  is_primary?: boolean;
};

export type ImportPackaging = {
  uom: Uom;
  units_per_parent?: number;
  gross_weight_kg?: number;
  net_weight_kg?: number;
  volume_m3?: number;
  length_cm?: number;
  width_cm?: number;
  height_cm?: number;
};

export type ImportProduct = {
  row: number;
  internal_sku: string;
  name?: Localized;
  manufacturer?: string;
  brand?: string;
  country_of_origin?: string;
  hs_code?: string;
  shelf_life_days?: number;
  composition?: Localized;
  nutrition_facts?: NutritionFacts;
  temperature_regime?: TemperatureRegime;
  temperature_range?: string;
  base_uom?: Uom;
  requires_sticker?: boolean;
  requires_marking?: boolean;
  status?: ProductStatus;
  identifiers: ImportIdentifier[];
  packaging: ImportPackaging[];
};

export type ReferencePackage = {
  format: typeof IMPORT_FORMAT;
  version: typeof IMPORT_VERSION;
  counterparties: ImportCounterparty[];
  products: ImportProduct[];
};

export type Issue = { source: string; row: number | null; message: string };

export const COUNTERPARTY_KEYS = [
  "row", "ref", "legal_name", "short_name", "roles", "country", "tax_id", "registration_number", "website", "preferred_locale",
] as const;
export const PRODUCT_KEYS = [
  "row", "internal_sku", "name", "manufacturer", "brand", "country_of_origin", "hs_code", "shelf_life_days", "composition",
  "nutrition_facts", "temperature_regime", "temperature_range", "temperature_min_c", "temperature_max_c", "base_uom",
  "requires_sticker", "requires_marking", "status", "identifiers", "packaging",
] as const;
export const IDENTIFIER_KEYS = ["type", "value", "counterparty", "packaging_uom", "is_primary"] as const;
export const PACKAGING_KEYS = [
  "uom", "units_per_parent", "gross_weight_kg", "net_weight_kg", "volume_m3", "length_cm", "width_cm", "height_cm",
] as const;

export type Collector = {
  take<T>(label: string | null, compute: () => T): T | null;
  fail(message: string): void;
  readonly failed: boolean;
  // Number of problems recorded so far; lets a nested object tell whether it failed.
  readonly count: number;
};

// Collects every problem of a row instead of stopping at the first one.
export function collector(issues: Issue[], source: string, row: number | null): Collector {
  let count = 0;
  const push = (message: string) => {
    issues.push({ source, row, message });
    count += 1;
  };
  return {
    take<T>(label: string | null, compute: () => T): T | null {
      try {
        return compute();
      } catch (error) {
        if (!(error instanceof NormalizeError)) throw error;
        push(label ? `${label}: ${error.message}` : error.message);
        return null;
      }
    },
    fail: push,
    get failed() {
      return count > 0;
    },
    get count() {
      return count;
    },
  };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);

// Drops null, undefined and empty objects so absent fields stay absent in the package.
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== null && item !== undefined && !(isObject(item) && !Object.keys(item).length)),
  ) as T;
}

function checkKeys(value: Record<string, unknown>, allowed: readonly string[], what: string, c: Collector) {
  for (const key of Object.keys(value)) {
    if (allowed.includes(key)) continue;
    c.fail(
      looksCommercial(key)
        ? `${what}: поле «${key}» похоже на цену или коммерческое условие — уберите его, такие данные в импорт справочника не включаются`
        : `${what}: неизвестное поле «${key}»`,
    );
  }
}

function rowOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : fallback;
}

function localized(value: unknown, max: number, label: string): Localized | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    const text = optionalText(value, max, label);
    return text ? { ru: text } : null;
  }
  const result: Localized = {};
  for (const [language, text] of Object.entries(value)) {
    const locale = language === "kz" ? "kk" : language;
    if (!["ru", "en", "kk"].includes(locale)) throw new NormalizeError(`${label}: язык «${language}» — допустимы ru, en, kk`);
    const clean = optionalText(text, max, `${label} (${locale})`);
    if (clean) result[locale as Locale] = clean;
  }
  return Object.keys(result).length ? result : null;
}

function nutrition(value: unknown, c: Collector, what: string): NutritionFacts | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) {
    c.fail(`${what}: КБЖУ — объект с полями basis, energy_kcal, protein_g…`);
    return null;
  }
  checkKeys(value, ["basis", ...NUTRITION_AMOUNTS], `${what}, КБЖУ`, c);
  const basis = c.take(what, () => normalizeNutritionBasis(value.basis, "КБЖУ, basis"));
  const result: NutritionFacts = basis ? { basis } : {};
  for (const key of NUTRITION_AMOUNTS) {
    const amount = c.take(what, () => parseDecimal(value[key], { scale: 3, max: 100_000, label: `КБЖУ, ${key}` }));
    if (amount === null) continue;
    if (key.endsWith("_g") && (basis ?? "100g") !== "serving" && amount > 100) {
      c.fail(`${what}: КБЖУ, ${key} больше 100 г на 100 г`);
      continue;
    }
    result[key] = amount;
  }
  return Object.keys(result).length ? result : null;
}

export function normalizeCounterparty(raw: unknown, index: number, source: string, issues: Issue[]): ImportCounterparty | null {
  const row = rowOf(isObject(raw) ? raw.row : null, index + 1);
  const c = collector(issues, source, row);
  const what = "Контрагент";
  if (!isObject(raw)) {
    c.fail(`${what}: ожидается объект`);
    return null;
  }
  checkKeys(raw, COUNTERPARTY_KEYS, what, c);
  const legalName = c.take(what, () => optionalText(raw.legal_name, 300, "юридическое название"));
  if (!cleanText(raw.legal_name)) c.fail(`${what}: не указано юридическое название (legal_name)`);
  const country = c.take(what, () => normalizeCountry(raw.country, "страна"));
  if (!cleanText(raw.country)) c.fail(`${what}: не указана страна (country)`);
  const result = compact({
    row,
    ref: c.take(what, () => optionalText(raw.ref, 300, "ref")),
    legal_name: legalName,
    short_name: c.take(what, () => optionalText(raw.short_name, 200, "краткое название")),
    roles: c.take(what, () => normalizeRoles(raw.roles, "роли")),
    country,
    tax_id: c.take(what, () => optionalText(raw.tax_id, 50, "БИН/ИНН")),
    registration_number: c.take(what, () => optionalText(raw.registration_number, 100, "регистрационный номер")),
    website: c.take(what, () => optionalText(raw.website, 300, "сайт")),
    preferred_locale: c.take(what, () => normalizeLocale(raw.preferred_locale, "язык")),
  });
  return c.failed ? null : (result as ImportCounterparty);
}

export function normalizeIdentifier(raw: unknown, c: Collector, what: string): ImportIdentifier | null {
  if (!isObject(raw)) {
    c.fail(`${what}: ожидается объект`);
    return null;
  }
  const start = c.count;
  checkKeys(raw, IDENTIFIER_KEYS, what, c);
  const type = cleanText(raw.type) as IdentifierType;
  if (!IDENTIFIER_TYPES.includes(type)) {
    c.fail(`${what}: тип — gtin, unit_barcode, box_barcode или supplier_sku`);
    return null;
  }
  const value = c.take(what, () =>
    type === "gtin" ? normalizeGtin(raw.value)
      : type === "supplier_sku" ? optionalText(raw.value, 100, "артикул поставщика")
        : normalizeBarcode(raw.value, type === "unit_barcode" ? "штрихкод единицы" : "штрихкод короба"),
  );
  const counterparty = c.take(what, () => optionalText(raw.counterparty, 300, "контрагент"));
  if (!cleanText(raw.value)) c.fail(`${what}: не указано значение`);
  if (type === "supplier_sku" && !counterparty) c.fail(`${what}: для артикула поставщика укажите поставщика или производителя`);
  if (type !== "supplier_sku" && counterparty) c.fail(`${what}: у штрихкода не указывается контрагент`);
  const identifier = compact({
    type,
    value,
    counterparty,
    packaging_uom: c.take(what, () => normalizeUom(raw.packaging_uom, "уровень упаковки")),
    is_primary: c.take(what, () => parseBoolean(raw.is_primary, "основной")),
  });
  return c.count > start ? null : (identifier as ImportIdentifier);
}

export function normalizePackagingLevel(raw: unknown, c: Collector, what: string): ImportPackaging | null {
  if (!isObject(raw)) {
    c.fail(`${what}: ожидается объект`);
    return null;
  }
  const start = c.count;
  checkKeys(raw, PACKAGING_KEYS, what, c);
  const uom = c.take(what, () => normalizeUom(raw.uom, "уровень"));
  if (!cleanText(raw.uom)) c.fail(`${what}: не указан уровень (piece, box, layer, pallet, truck)`);
  if (!uom) return null;
  const number = (key: string, scale: number, max: number, positive = false) =>
    c.take(what, () => parseDecimal(raw[key], { scale, max, positive, label: key }));
  const level = compact({
    uom,
    units_per_parent: number("units_per_parent", 3, 1_000_000_000, true),
    gross_weight_kg: number("gross_weight_kg", 3, 10_000_000),
    net_weight_kg: number("net_weight_kg", 3, 10_000_000),
    volume_m3: number("volume_m3", 4, 1_000_000),
    length_cm: number("length_cm", 2, 1_000_000),
    width_cm: number("width_cm", 2, 1_000_000),
    height_cm: number("height_cm", 2, 1_000_000),
  }) as ImportPackaging;
  if (level.net_weight_kg !== undefined && level.gross_weight_kg !== undefined && level.net_weight_kg > level.gross_weight_kg) {
    c.fail(`${what}: вес нетто больше веса брутто`);
  }
  return c.count > start ? null : level;
}

export function normalizeProduct(raw: unknown, index: number, source: string, issues: Issue[]): ImportProduct | null {
  const row = rowOf(isObject(raw) ? raw.row : null, index + 1);
  const c = collector(issues, source, row);
  if (!isObject(raw)) {
    c.fail("Товар: ожидается объект");
    return null;
  }
  const sku = c.take("Товар", () => optionalText(raw.internal_sku, 64, "внутренний артикул"));
  const what = sku ? `Товар ${sku}` : "Товар";
  if (!cleanText(raw.internal_sku)) c.fail(`${what}: не указан внутренний артикул (internal_sku)`);
  checkKeys(raw, PRODUCT_KEYS, what, c);

  const range = c.take(what, () => optionalText(raw.temperature_range, 50, "диапазон температур"));
  const min = c.take(what, () => parseTemperature(raw.temperature_min_c, "температура от"));
  const max = c.take(what, () => parseTemperature(raw.temperature_max_c, "температура до"));
  const built = c.take(what, () => formatTemperatureRange(min, max));
  if (range && built) c.fail(`${what}: укажите либо temperature_range, либо temperature_min_c / temperature_max_c`);

  const identifiers: ImportIdentifier[] = [];
  const packaging: ImportPackaging[] = [];
  for (const [key, list] of [["identifiers", raw.identifiers], ["packaging", raw.packaging]] as const) {
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      c.fail(`${what}: ${key} — массив`);
      continue;
    }
    list.forEach((item, position) => {
      const label = `${what}, ${key === "identifiers" ? "идентификатор" : "упаковка"} ${position + 1}`;
      if (key === "identifiers") {
        const identifier = normalizeIdentifier(item, c, label);
        if (identifier) identifiers.push(identifier);
      } else {
        const level = normalizePackagingLevel(item, c, label);
        if (level) packaging.push(level);
      }
    });
  }
  const product = compact({
    row,
    internal_sku: sku,
    name: c.take(what, () => localized(raw.name, 300, "название")),
    manufacturer: c.take(what, () => optionalText(raw.manufacturer, 300, "производитель")),
    brand: c.take(what, () => optionalText(raw.brand, 200, "бренд")),
    country_of_origin: c.take(what, () => normalizeCountry(raw.country_of_origin, "страна происхождения")),
    hs_code: c.take(what, () => normalizeHsCode(raw.hs_code, "код ТН ВЭД")),
    shelf_life_days: c.take(what, () => parseInteger(raw.shelf_life_days, { min: 1, max: 36_500, label: "срок годности, дней" })),
    composition: c.take(what, () => localized(raw.composition, 4000, "состав")),
    nutrition_facts: nutrition(raw.nutrition_facts, c, what),
    temperature_regime: c.take(what, () => normalizeTemperatureRegime(raw.temperature_regime, "температурный режим")),
    temperature_range: range ?? built,
    base_uom: c.take(what, () => normalizeUom(raw.base_uom, "базовая единица")),
    requires_sticker: c.take(what, () => parseBoolean(raw.requires_sticker, "стикеровка")),
    requires_marking: c.take(what, () => parseBoolean(raw.requires_marking, "маркировка")),
    status: c.take(what, () => normalizeProductStatus(raw.status, "статус")),
  }) as Omit<ImportProduct, "identifiers" | "packaging">;
  checkChildLimits(identifiers.length, packaging.length, c, what);
  return c.failed ? null : { ...product, identifiers, packaging };
}

export function checkChildLimits(identifiers: number, packaging: number, c: Collector, what: string) {
  if (identifiers > MAX_IDENTIFIERS_PER_PRODUCT) c.fail(`${what}: не больше ${MAX_IDENTIFIERS_PER_PRODUCT} идентификаторов`);
  if (packaging > MAX_PACKAGING_PER_PRODUCT) c.fail(`${what}: не больше ${MAX_PACKAGING_PER_PRODUCT} уровней упаковки`);
}

// Counts are rows of the source, including rows that failed validation.
export function checkPackageLimits(counterparties: number, products: number, issues: Issue[], source: string) {
  if (!counterparties && !products) issues.push({ source, row: null, message: "В файле нет ни контрагентов, ни товаров" });
  if (counterparties > MAX_COUNTERPARTIES || products > MAX_PRODUCTS) {
    issues.push({
      source,
      row: null,
      message: `За один раз — не больше ${MAX_COUNTERPARTIES} контрагентов и ${MAX_PRODUCTS} товаров. Разделите файл на части.`,
    });
  }
}

// Validates and normalises a package read from JSON. The package is returned together
// with every problem found; it may be sent to the database only when issues is empty.
export function normalizePackage(raw: unknown, source = "JSON"): { pkg: ReferencePackage; issues: Issue[] } {
  const issues: Issue[] = [];
  const pkg: ReferencePackage = { format: IMPORT_FORMAT, version: IMPORT_VERSION, counterparties: [], products: [] };
  const c = collector(issues, source, null);
  if (!isObject(raw)) {
    c.fail("Ожидается JSON-объект пакета");
    return { pkg, issues };
  }
  checkKeys(raw, ["format", "version", "counterparties", "products"], "Пакет", c);
  if (raw.format !== IMPORT_FORMAT || raw.version !== IMPORT_VERSION) {
    c.fail(`Пакет: ожидается "format": "${IMPORT_FORMAT}" и "version": ${IMPORT_VERSION}`);
  }
  const counts = { counterparties: 0, products: 0 };
  for (const key of ["counterparties", "products"] as const) {
    const list = raw[key];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list)) {
      c.fail(`Пакет: ${key} — массив`);
      continue;
    }
    counts[key] = list.length;
    list.forEach((item, index) => {
      if (key === "counterparties") {
        const party = normalizeCounterparty(item, index, source, issues);
        if (party) pkg.counterparties.push(party);
      } else {
        const product = normalizeProduct(item, index, source, issues);
        if (product) pkg.products.push(product);
      }
    });
  }
  if (!c.failed || counts.counterparties || counts.products) checkPackageLimits(counts.counterparties, counts.products, issues, source);
  return { pkg, issues };
}

export function packageStats(pkg: ReferencePackage) {
  return {
    counterparties: pkg.counterparties.length,
    products: pkg.products.length,
    identifiers: pkg.products.reduce((sum, product) => sum + product.identifiers.length, 0),
    packaging: pkg.products.reduce((sum, product) => sum + product.packaging.length, 0),
  };
}
