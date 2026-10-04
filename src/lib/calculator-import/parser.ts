import { cleanText, normalizeHeader, type Cell } from "../reference-import/normalize.ts";
import {
  IMPORT_FORMAT,
  IMPORT_VERSION,
  type ImportCounterparty,
  type ImportPackaging,
  type ImportProduct,
  type Issue,
  type ReferencePackage,
  normalizePackage,
} from "../reference-import/package.ts";

export const CALCULATOR_FORMAT = "nexus-calculator-import" as const;
export const CALCULATOR_VERSION = 1 as const;
export const CALCULATOR_SOURCE_KEY = "arseo-master-calculator";
export const CALCULATOR_SHEET_NAMES = new Set(["расчеты", "расчёты"]);

export type CalculatorVisibility = "catalog" | "sales" | "confidential";
export type CalculatorColumn = {
  key: string;
  position: number;
  source_number: string | null;
  source_code: string | null;
  block: string | null;
  field_en: string | null;
  field_ru: string;
  visibility: CalculatorVisibility;
};
export type CalculatorSourceRow = {
  row: number;
  internal_sku: string;
  category: string | null;
  catalog_data: Record<string, unknown>;
  sales_data: Record<string, unknown>;
  confidential_data: Record<string, unknown>;
};
export type CalculatorImportPackage = {
  format: typeof CALCULATOR_FORMAT;
  version: typeof CALCULATOR_VERSION;
  reference: ReferencePackage;
  source: {
    key: typeof CALCULATOR_SOURCE_KEY;
    title: string;
    sheet_name: string;
    header_rows: 5;
    header_fingerprint: string;
    columns: CalculatorColumn[];
    rows: CalculatorSourceRow[];
  };
};

const norm = (value: unknown) => normalizeHeader(cleanText(value));
const text = (value: unknown) => cleanText(value) || null;
const number = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const candidate = cleanText(value).replace(/\s/g, "").replace(",", ".");
  return candidate && /^-?\d+(?:\.\d+)?$/.test(candidate) ? Number(candidate) : null;
};
const positive = (value: unknown) => {
  const parsed = number(value);
  return parsed !== null && parsed > 0 ? parsed : null;
};
const divide = (value: unknown, divisor: number) => {
  const parsed = positive(value);
  return parsed === null ? null : Math.round((parsed / divisor) * 1000) / 1000;
};
const weight = (value: unknown) => {
  const parsed = positive(value);
  return parsed === null ? null : Math.round(parsed * 1000) / 1000;
};

const BLOCKS: Array<[string, string, string]> = [
  ["Individual packing data // Информация по индивидуальной упаковке", "Вид упаковки", "Бренд"],
  ["Transportation box data // Информация по транспортной упаковке", "Штук товара в коробке", "Длина кор, мм"],
  ["Europallet data // Информация по европаллете", "Штук на паллете", "Можно стоппировать"],
  ["Truckload data // Информация по загрузке в фуру", "Количество штук в фуре", "Вес брутто с учетом веса паллет, кг"],
  ["Информация о закупе", "Страна происхождения товара", "Цена за единицу"],
  ["Транспортировка и растаможка", "ТНВЭД", "НДС на штуку"],
  ["Подготовка и доставыка товара", "Прочие на единицу\n(брокер, пошлина, банк.комиссия, СВХ)", "Доставка мелкими партиями до клиента\n(Доставка по КЗ+разгрузка+до ТТ+хранение)"],
  ["РАСЧЕТНЫЕ ЦЕНЫ", "Маржа в KZ", "EXW Almaty/Aktobe, KAZAKHSTAN\n БЕЗ НДС\nEUR"],
  ["УСТАНОВЛЕННЫЕ ЦЕНЫ", "ЦП в КЗ сеть с НДС, тенге", "КЫРГЫЗСТАН\nEXW ALA\n БЕЗ НДС\nEUR"],
];

const CANONICAL = new Map<string, string>([
  [norm("Активный асс-т  ARSEO"), "product.active_arseo"],
  [norm("Активный асс-т  KAZ"), "product.active_kaz"],
  [norm("Артикул ARSEO"), "product.internal_sku"],
  [norm("Фото продукции"), "product.image"],
  [norm("Наименование (рус)"), "product.name.ru"],
  [norm("Наименование (англ)"), "product.name.en"],
  [norm("Артикул производителя"), "product.supplier_sku"],
  [norm("Штрих код"), "product.unit_barcode"],
  [norm("Штрих код короба"), "product.box_barcode"],
  [norm("Бренд"), "product.brand"],
  [norm("Страна происхождения товара"), "product.country_of_origin"],
  [norm("ТНВЭД"), "product.hs_code"],
  [norm("Срок годности, дни"), "product.shelf_life_days"],
  [norm("Производитель"), "product.manufacturer"],
  [norm("Категория товаров"), "product.category"],
  [norm("Наименование (каз)"), "product.name.kk"],
  [norm("Описание товара (состав на рус. языке)"), "product.composition.ru"],
  [norm("Описание товара (состав на каз. языке)"), "product.composition.kk"],
  [norm("Минимальная температура хранения"), "product.temperature_min_c"],
  [norm("Максимальная температура хранения"), "product.temperature_max_c"],
  [norm("Температурная зона хранения"), "product.temperature_regime"],
  [norm("Белки, г"), "product.nutrition.protein_g"],
  [norm("Жиры, г"), "product.nutrition.fat_g"],
  [norm("Углеводы, г"), "product.nutrition.carbohydrates_g"],
  [norm("Сахар, г"), "product.nutrition.sugars_g"],
  [norm("Соль"), "product.nutrition.salt_g"],
  [norm("Энерг.\n ценность,\n  ккал"), "product.nutrition.energy_kcal"],
  [norm("Энерг. ценность,  кДж"), "product.nutrition.energy_kj"],
]);

const DISPLAY_FIELD_LABELS = new Map<string, { ru: string; en: string }>([
  [norm("Штук на паллете"), { ru: "Количество коробов на паллете", en: "Boxes per pallet" }],
  [norm("Количество штук в фуре"), { ru: "Количество паллет в машине", en: "Pallets per truck" }],
]);

const COUNTRY: Record<string, string> = {
  belgium: "BE", finland: "FI", italy: "IT", spain: "ES", sweden: "SE",
  "германия": "DE", "казахстан": "KZ", "нидерланды": "NL", "турция": "TR", "финляндия": "FI",
};
const MANUFACTURER_ALIAS: Record<string, string> = {
  "froosh ab": "Fazer Confectionary Ltd",
};
const MANUFACTURER_COUNTRY: Record<string, string> = {
  "Fazer Confectionary Ltd": "FI",
};

function visibility(block: string | null, field: string): CalculatorVisibility {
  const b = norm(block);
  const f = norm(field);
  if (CANONICAL.has(f)) return "catalog";
  if (b === norm("Информация о закупе") && /предыдущая_цена|цена_за_единицу/.test(f)) return "confidential";
  if ([norm("Транспортировка и растаможка"), norm("Подготовка и доставыка товара")].includes(b)) return "confidential";
  if (b === norm("РАСЧЕТНЫЕ ЦЕНЫ")) {
    return /маржа|себестоимость/.test(f) ? "confidential" : "sales";
  }
  if (b === norm("УСТАНОВЛЕННЫЕ ЦЕНЫ")) return /маржа/.test(f) ? "confidential" : "sales";
  if (/себестоимость|закупочн|предыдущая_цена|маржа/.test(f)) return "confidential";
  return "catalog";
}

function columnKey(block: string | null, fieldRu: string, used: Set<string>) {
  const canonical = CANONICAL.get(norm(fieldRu));
  let key = canonical ?? `source.${block ? `${norm(block)}.` : ""}${norm(fieldRu)}`;
  const base = key;
  let suffix = 2;
  while (used.has(key)) key = `${base}.${suffix++}`;
  used.add(key);
  return key;
}

function headerColumns(rows: Cell[][], issues: Issue[]): CalculatorColumn[] {
  if (rows.length < 5) {
    issues.push({ source: "Калькулятор", row: null, message: "В листе нет пяти строк заголовка" });
    return [];
  }
  const width = Math.max(...rows.slice(0, 5).map((row) => row.length));
  const blockByIndex = new Map<number, string>();
  for (const [block, first, last] of BLOCKS) {
    const start = rows[4].findIndex((value) => norm(value) === norm(first));
    const end = rows[4].findIndex((value) => norm(value) === norm(last));
    if (start < 0 && end < 0) continue;
    if (start < 0 || end < start) {
      issues.push({ source: "Калькулятор", row: 5, message: `Изменена структура блока «${block}»: не найдены его границы` });
      continue;
    }
    for (let index = start; index <= end; index += 1) blockByIndex.set(index, block);
  }
  const used = new Set<string>();
  const result: CalculatorColumn[] = [];
  for (let index = 0; index < width; index += 1) {
    const sourceFieldRu = text(rows[4]?.[index]);
    if (!sourceFieldRu) continue;
    const display = DISPLAY_FIELD_LABELS.get(norm(sourceFieldRu));
    const fieldRu = display?.ru ?? sourceFieldRu;
    const block = blockByIndex.get(index) ?? null;
    result.push({
      key: columnKey(block, fieldRu, used),
      position: index + 1,
      source_number: text(rows[0]?.[index]),
      source_code: text(rows[1]?.[index]),
      block,
      field_en: display?.en ?? text(rows[3]?.[index]),
      field_ru: fieldRu,
      visibility: visibility(block, fieldRu),
    });
  }
  for (const required of ["product.internal_sku", "product.name.ru", "product.supplier_sku", "product.manufacturer", "product.category"]) {
    if (!result.some((column) => column.key === required)) issues.push({ source: "Калькулятор", row: 5, message: `Не найдено обязательное поле ${required}` });
  }
  return result;
}

function valueAt(row: Cell[], columns: CalculatorColumn[], key: string): Cell | null {
  const column = columns.find((item) => item.key === key);
  return column ? row[column.position - 1] ?? null : null;
}
function manufacturer(value: unknown) {
  const raw = cleanText(value);
  return MANUFACTURER_ALIAS[raw.toLowerCase()] ?? raw;
}
function country(value: unknown): string | null {
  const raw = cleanText(value);
  if (/^[A-Za-z]{2}$/.test(raw)) return raw.toUpperCase();
  return COUNTRY[raw.toLowerCase()] ?? null;
}
function flag(value: unknown) {
  if (typeof value === "boolean") return value;
  const parsed = number(value);
  if (parsed !== null) return parsed > 0;
  return /^(да|yes|active|актив)/i.test(cleanText(value));
}
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined && item !== "")) as T;
}
function packaging(rows: Cell[], columns: CalculatorColumn[]): ImportPackaging[] {
  const get = (label: string) => {
    const column = columns.find((item) => norm(item.field_ru) === norm(label));
    return column ? rows[column.position - 1] : null;
  };
  const levels: ImportPackaging[] = [];
  const push = (level: ImportPackaging | null) => { if (level?.units_per_parent) levels.push(compact(level)); };
  push({ uom: "piece", units_per_parent: 1, net_weight_kg: weight(get("Вес нетто ед, кг")) ?? divide(get("Вес нетто ед, г"), 1000) ?? undefined,
    gross_weight_kg: weight(get("Вес брутто ед, кг")) ?? divide(get("Вес брутто ед, г"), 1000) ?? undefined,
    height_cm: divide(get("Высота ед, мм"), 10) ?? positive(get("Высота ед, см")) ?? undefined,
    width_cm: divide(get("Ширина ед, мм"), 10) ?? positive(get("Ширина ед, см")) ?? undefined,
    length_cm: divide(get("Длина ед, мм"), 10) ?? positive(get("Длина ед, см")) ?? undefined });
  push({ uom: "box", units_per_parent: positive(get("Штук товара в коробке")) ?? undefined,
    gross_weight_kg: weight(get("Вес брутто, кг")) ?? divide(get("Вес брутто кор, г"), 1000) ?? undefined,
    height_cm: divide(get("Высота кор, мм"), 10) ?? positive(get("Высота короба, см")) ?? undefined,
    width_cm: divide(get("Ширина кор, мм"), 10) ?? positive(get("Ширина короба, см")) ?? undefined,
    length_cm: divide(get("Длина кор, мм"), 10) ?? positive(get("Длина короба, см")) ?? undefined });
  push({ uom: "pallet", units_per_parent: positive(get("Количество коробов на паллете")) ?? undefined,
    gross_weight_kg: weight(get("Вес брутто с учетом веса паллеты, кг")) ?? weight(get("Вес брутто паллета, кг")) ?? undefined });
  push({ uom: "truck", units_per_parent: positive(get("Количество паллет в машине")) ?? undefined,
    gross_weight_kg: weight(get("Вес брутто с учетом веса паллет, кг")) ?? undefined });
  return levels;
}

function fingerprint(columns: CalculatorColumn[]) {
  // Deterministic and position-independent; used for drift detection, not security.
  // Row 4 sometimes contains coefficients/formulas rather than a label, so it is
  // preserved in the schema but intentionally excluded from identity.
  return columns.map(({ key, block, field_ru, visibility: access }) => [key, block, field_ru, access].map((v) => v ?? "").join("|")).sort().join("\n");
}

export function isCalculatorSheet(name: string) {
  return CALCULATOR_SHEET_NAMES.has(norm(name));
}

export function buildCalculatorPackage(rows: Cell[][], sourceTitle: string, sheetName: string): { pkg: CalculatorImportPackage; issues: Issue[] } {
  const issues: Issue[] = [];
  const columns = headerColumns(rows, issues);
  const referenceRaw: ReferencePackage = { format: IMPORT_FORMAT, version: IMPORT_VERSION, counterparties: [], products: [] };
  const sourceRows: CalculatorSourceRow[] = [];
  const parties = new Map<string, ImportCounterparty>();

  const skuColumn = columns.find((column) => column.key === "product.internal_sku")?.position ?? 0;
  const nameColumn = columns.find((column) => column.key === "product.name.ru")?.position ?? 0;
  const manufacturerColumn = columns.find((column) => column.key === "product.manufacturer")?.position ?? 0;
  const activeColumns = columns.filter((column) => column.key === "product.active_arseo" || column.key === "product.active_kaz").map((column) => column.position);
  const grouped = new Map<string, Array<{ row: Cell[]; rowNumber: number }>>();
  rows.slice(5).forEach((row, offset) => {
    const rowNumber = offset + 6;
    const sku = cleanText(row[skuColumn - 1]);
    const name = cleanText(row[nameColumn - 1]);
    const maker = cleanText(row[manufacturerColumn - 1]);
    const explicitlyInactive = activeColumns.length > 0 && activeColumns.every((position) => /^(нет|временно\s+нет|no)$/i.test(cleanText(row[position - 1])));
    if (!sku && !name && !maker) return;
    if (!name && explicitlyInactive) return; // Empty historical placeholders are not product records.
    if (!sku) {
      issues.push({ source: `${sourceTitle} · ${sheetName}`, row: rowNumber, message: "Строка товара не готова к импорту: артикул ARSEO" });
      return;
    }
    const list = grouped.get(sku) ?? [];
    list.push({ row, rowNumber });
    grouped.set(sku, list);
  });
  const mergedRows = [...grouped.values()].map((variants) => {
    const sorted = variants.toSorted((a, b) => b.row.filter((value) => cleanText(value)).length - a.row.filter((value) => cleanText(value)).length);
    const merged = [...sorted[0].row];
    for (const variant of sorted.slice(1)) variant.row.forEach((value, index) => { if (!cleanText(merged[index]) && cleanText(value)) merged[index] = value; });
    return { row: merged, rowNumber: sorted[0].rowNumber };
  });

  mergedRows.forEach(({ row, rowNumber }) => {
    const sku = cleanText(valueAt(row, columns, "product.internal_sku"));
    const nameRu = cleanText(valueAt(row, columns, "product.name.ru"));
    const rawManufacturer = cleanText(valueAt(row, columns, "product.manufacturer"));
    if (!sku && !nameRu && !rawManufacturer) return;
    const maker = manufacturer(rawManufacturer);
    if (!sku || !nameRu || !maker || maker === "#N/A") {
      const missing = [!sku && "артикул ARSEO", !nameRu && "наименование", (!maker || maker === "#N/A") && "производитель"].filter(Boolean).join(", ");
      issues.push({ source: `${sourceTitle} · ${sheetName}`, row: rowNumber, message: `Строка товара не готова к импорту: ${missing}` });
      return;
    }
    const origin = country(valueAt(row, columns, "product.country_of_origin"));
    if (!origin) issues.push({ source: `${sourceTitle} · ${sheetName}`, row: rowNumber, message: "Не удалось определить двухбуквенный код страны происхождения" });
    const makerCountry = MANUFACTURER_COUNTRY[maker] ?? origin;
    if (makerCountry && !parties.has(maker)) parties.set(maker, { row: rowNumber, ref: maker, legal_name: maker, short_name: maker, roles: ["manufacturer", "supplier"], country: makerCountry });

    const get = (key: string) => valueAt(row, columns, key);
    const identifiers: ImportProduct["identifiers"] = [];
    const unitBarcode = cleanText(get("product.unit_barcode"));
    const boxBarcode = cleanText(get("product.box_barcode"));
    if (/^[A-Za-z0-9-]{4,48}$/.test(unitBarcode)) identifiers.push({ type: "unit_barcode", value: unitBarcode, is_primary: true });
    if (/^[A-Za-z0-9-]{4,48}$/.test(boxBarcode)) identifiers.push({ type: "box_barcode", value: boxBarcode, packaging_uom: "box" });
    if (text(get("product.supplier_sku"))) identifiers.push({ type: "supplier_sku", value: cleanText(get("product.supplier_sku")), counterparty: maker, is_primary: true });
    const product: ImportProduct = compact({
      row: rowNumber,
      internal_sku: sku,
      name: compact({ ru: nameRu, en: text(get("product.name.en")), kk: text(get("product.name.kk")) }),
      manufacturer: maker,
      brand: text(get("product.brand")),
      country_of_origin: origin,
      hs_code: text(get("product.hs_code")),
      shelf_life_days: positive(get("product.shelf_life_days")),
      composition: compact({ ru: text(get("product.composition.ru")), kk: text(get("product.composition.kk")) }),
      nutrition_facts: compact({ basis: "100g", protein_g: number(get("product.nutrition.protein_g")), fat_g: number(get("product.nutrition.fat_g")),
        carbohydrates_g: number(get("product.nutrition.carbohydrates_g")), sugars_g: number(get("product.nutrition.sugars_g")), salt_g: number(get("product.nutrition.salt_g")),
        energy_kcal: number(get("product.nutrition.energy_kcal")), energy_kj: number(get("product.nutrition.energy_kj")) }),
      temperature_min_c: number(get("product.temperature_min_c")),
      temperature_max_c: number(get("product.temperature_max_c")),
      base_uom: "piece",
      requires_sticker: positive(columns.find((item) => norm(item.field_ru) === norm("Стикеровка")) ? row[columns.find((item) => norm(item.field_ru) === norm("Стикеровка"))!.position - 1] : null) !== null,
      requires_marking: positive(columns.find((item) => norm(item.field_ru) === norm("Маркировка ЧЗ")) ? row[columns.find((item) => norm(item.field_ru) === norm("Маркировка ЧЗ"))!.position - 1] : null) !== null,
      status: flag(get("product.active_arseo")) ? "active" : "draft",
      identifiers,
      packaging: packaging(row, columns),
    }) as ImportProduct;
    referenceRaw.products.push(product);

    const buckets: Record<CalculatorVisibility, Record<string, unknown>> = { catalog: {}, sales: {}, confidential: {} };
    for (const column of columns) {
      const value = row[column.position - 1];
      if (value !== null && value !== undefined && cleanText(value) !== "") buckets[column.visibility][column.key] = value instanceof Date ? value.toISOString() : value;
    }
    sourceRows.push({ row: rowNumber, internal_sku: sku, category: text(get("product.category")), catalog_data: buckets.catalog, sales_data: buckets.sales, confidential_data: buckets.confidential });
  });

  referenceRaw.counterparties = [...parties.values()];
  const normalized = normalizePackage(referenceRaw, `${sourceTitle} · ${sheetName}`);
  issues.push(...normalized.issues);
  return {
    pkg: {
      format: CALCULATOR_FORMAT,
      version: CALCULATOR_VERSION,
      reference: normalized.pkg,
      source: { key: CALCULATOR_SOURCE_KEY, title: sourceTitle, sheet_name: sheetName, header_rows: 5, header_fingerprint: fingerprint(columns), columns, rows: sourceRows },
    },
    issues,
  };
}

