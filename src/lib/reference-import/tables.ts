// Spreadsheet input (CSV/TSV files, XLSX sheets) for the reference import. Each table is
// recognised by its header row and converted into the same package as the JSON format.

import { type Cell, cleanText, looksCommercial, normalizeHeader } from "./normalize.ts";
import {
  type ImportIdentifier,
  type ImportPackaging,
  type ImportProduct,
  type Issue,
  type ReferencePackage,
  IMPORT_FORMAT,
  IMPORT_VERSION,
  checkChildLimits,
  checkPackageLimits,
  collector,
  normalizeCounterparty,
  normalizeIdentifier,
  normalizePackagingLevel,
  normalizeProduct,
} from "./package.ts";

export type Table = { source: string; rows: Cell[][] };
export type TableKind = "counterparties" | "products" | "identifiers" | "packaging";

// Canonical column -> accepted header spellings (compared after normalizeHeader()).
export const TABLE_COLUMNS: Record<TableKind, Record<string, string[]>> = {
  counterparties: {
    ref: ["ссылка", "код_контрагента"],
    legal_name: ["юридическое_название", "наименование_контрагента", "название_компании", "контрагент"],
    short_name: ["краткое_название"],
    roles: ["роли", "роль", "тип_контрагента"],
    country: ["страна"],
    tax_id: ["бин", "инн", "бин_инн", "vat", "налоговый_номер"],
    registration_number: ["регистрационный_номер", "рег_номер"],
    website: ["сайт"],
    preferred_locale: ["язык"],
  },
  products: {
    internal_sku: ["внутренний_артикул", "артикул_nexus", "код_товара", "sku"],
    name_ru: ["наименование", "название", "наименование_ru", "название_ru"],
    name_en: ["наименование_en", "название_en"],
    name_kk: ["name_kz", "наименование_kk", "наименование_kz", "название_kz"],
    manufacturer: ["производитель"],
    supplier: ["поставщик"],
    brand: ["бренд", "торговая_марка"],
    country_of_origin: ["страна_происхождения"],
    hs_code: ["тн_вэд", "тнвэд", "код_тн_вэд"],
    shelf_life_days: ["срок_годности", "срок_годности_дней", "срок_годности_дн"],
    composition_ru: ["состав", "состав_ru"],
    composition_en: ["состав_en"],
    composition_kk: ["composition_kz", "состав_kk", "состав_kz"],
    nutrition_basis: ["кбжу_на"],
    energy_kcal: ["ккал", "калорийность", "энергетическая_ценность_ккал"],
    energy_kj: ["кдж", "энергетическая_ценность_кдж"],
    protein_g: ["белки", "белки_г"],
    fat_g: ["жиры", "жиры_г"],
    saturated_fat_g: ["насыщенные_жиры", "насыщенные_жиры_г"],
    carbohydrates_g: ["углеводы", "углеводы_г"],
    sugars_g: ["сахара", "сахара_г"],
    fiber_g: ["клетчатка", "клетчатка_г"],
    salt_g: ["соль", "соль_г"],
    temperature_regime: ["температурный_режим"],
    temperature_range: ["диапазон_температур"],
    temperature_min_c: ["температура_от"],
    temperature_max_c: ["температура_до"],
    base_uom: ["базовая_единица"],
    requires_sticker: ["стикеровка"],
    requires_marking: ["маркировка", "честный_знак"],
    status: ["статус"],
    gtin: ["ean"],
    unit_barcode: ["шк_единицы", "штрихкод_единицы"],
    box_barcode: ["шк_короба", "штрихкод_короба"],
    supplier_sku: ["артикул_поставщика"],
  },
  identifiers: {
    internal_sku: ["внутренний_артикул", "артикул_nexus", "код_товара", "sku"],
    identifier_type: ["тип_идентификатора"],
    value: ["значение"],
    counterparty: ["контрагент", "поставщик"],
    packaging_uom: ["уровень_упаковки"],
    is_primary: ["основной"],
  },
  packaging: {
    internal_sku: ["внутренний_артикул", "артикул_nexus", "код_товара", "sku"],
    uom: ["уровень", "уровень_упаковки"],
    units_per_parent: ["вложение", "количество_в_уровне"],
    gross_weight_kg: ["вес_брутто_кг", "брутто_кг"],
    net_weight_kg: ["вес_нетто_кг", "нетто_кг"],
    volume_m3: ["объем_м3"],
    length_cm: ["длина_см"],
    width_cm: ["ширина_см"],
    height_cm: ["высота_см"],
  },
};

const REQUIRED: Record<TableKind, string[]> = {
  identifiers: ["internal_sku", "identifier_type", "value"],
  packaging: ["internal_sku", "uom", "units_per_parent"],
  products: ["internal_sku"],
  counterparties: ["legal_name", "roles"],
};
const DETECTION_ORDER: TableKind[] = ["identifiers", "packaging", "products", "counterparties"];

const KIND_LABEL: Record<TableKind, string> = {
  counterparties: "контрагенты",
  products: "товары",
  identifiers: "идентификаторы",
  packaging: "упаковка",
};

function columnFor(kind: TableKind, header: string): string | null {
  for (const [column, aliases] of Object.entries(TABLE_COLUMNS[kind])) {
    if (header === column || aliases.includes(header)) return column;
  }
  return null;
}

// Detects the delimiter (";", "," or tab) from the first line and parses RFC 4180 CSV.
// Excel in Russian locales saves ";"-separated files, where "," is the decimal mark.
export function parseCsv(source: string): string[][] {
  const text = source.replace(/^﻿/, "");
  const counts = { ";": 0, ",": 0, "\t": 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && char in counts) counts[char as keyof typeof counts] += 1;
  }
  const [best, bestCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const delimiter = bestCount > 0 ? best : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const isEmptyRow = (row: Cell[] | undefined) => !row || row.every((value) => !cleanText(value));

type ParsedRow = { row: number; values: Record<string, Cell> };

// Finds the header row, recognises the table and maps its rows to canonical columns.
export function readTable(table: Table, issues: Issue[]): { kind: TableKind; rows: ParsedRow[] } | null {
  const headerIndex = table.rows.findIndex((row) => !isEmptyRow(row));
  if (headerIndex < 0) {
    issues.push({ source: table.source, row: null, message: "Таблица пуста" });
    return null;
  }
  const headers = table.rows[headerIndex].map(normalizeHeader);
  const kind = DETECTION_ORDER.find((candidate) =>
    REQUIRED[candidate].every((column) => headers.some((header) => columnFor(candidate, header) === column)),
  );
  if (!kind) {
    issues.push({
      source: table.source,
      row: headerIndex + 1,
      message: "Не удалось определить таблицу: нужны колонки legal_name и roles (контрагенты), internal_sku (товары), internal_sku + identifier_type + value (идентификаторы) или internal_sku + uom + units_per_parent (упаковка)",
    });
    return null;
  }

  const columns: (string | null)[] = [];
  const seen = new Set<string>();
  const dataRows = table.rows.slice(headerIndex + 1);
  table.rows[headerIndex].forEach((raw, index) => {
    const header = headers[index];
    const column = header ? columnFor(kind, header) : null;
    columns.push(column);
    const label = cleanText(raw);
    if (!header) {
      if (dataRows.some((row) => cleanText(row[index]))) {
        issues.push({ source: table.source, row: headerIndex + 1, message: `Колонка ${index + 1} без заголовка содержит данные` });
      }
      return;
    }
    if (!column) {
      issues.push({
        source: table.source,
        row: headerIndex + 1,
        message: looksCommercial(label)
          ? `Колонка «${label}» похожа на цену или коммерческое условие — удалите её, такие данные в импорт справочника не включаются`
          : `Неизвестная колонка «${label}» в таблице «${KIND_LABEL[kind]}»`,
      });
      return;
    }
    if (seen.has(column)) issues.push({ source: table.source, row: headerIndex + 1, message: `Колонка «${label}» повторяется` });
    seen.add(column);
  });

  const rows: ParsedRow[] = [];
  dataRows.forEach((cells, offset) => {
    if (isEmptyRow(cells)) return;
    const values: Record<string, Cell> = {};
    columns.forEach((column, index) => {
      if (column && cleanText(cells[index]) !== "") values[column] = cells[index];
    });
    rows.push({ row: headerIndex + offset + 2, values });
  });
  return { kind, rows };
}

function localizedFrom(values: Record<string, Cell>, prefix: string) {
  const result: Record<string, Cell> = {};
  for (const language of ["ru", "en", "kk"]) {
    if (values[`${prefix}_${language}`] !== undefined) result[language] = values[`${prefix}_${language}`];
  }
  return Object.keys(result).length ? result : undefined;
}

const NUTRITION_COLUMNS = [
  "energy_kcal", "energy_kj", "protein_g", "fat_g", "saturated_fat_g", "carbohydrates_g", "sugars_g", "fiber_g", "salt_g",
];

// Flat product row -> the product object of the JSON format.
function productFromRow(values: Record<string, Cell>, row: number): Record<string, unknown> {
  const nutrition: Record<string, Cell> = {};
  if (values.nutrition_basis !== undefined) nutrition.basis = values.nutrition_basis;
  for (const key of NUTRITION_COLUMNS) if (values[key] !== undefined) nutrition[key] = values[key];
  const identifiers: Record<string, unknown>[] = [];
  if (values.gtin !== undefined) identifiers.push({ type: "gtin", value: values.gtin, is_primary: true });
  if (values.unit_barcode !== undefined) identifiers.push({ type: "unit_barcode", value: values.unit_barcode });
  if (values.box_barcode !== undefined) identifiers.push({ type: "box_barcode", value: values.box_barcode, packaging_uom: "box" });
  if (values.supplier_sku !== undefined) {
    identifiers.push({ type: "supplier_sku", value: values.supplier_sku, counterparty: values.supplier ?? values.manufacturer, is_primary: true });
  }
  const product: Record<string, unknown> = {
    row,
    internal_sku: values.internal_sku,
    name: localizedFrom(values, "name"),
    composition: localizedFrom(values, "composition"),
    nutrition_facts: Object.keys(nutrition).length ? nutrition : undefined,
    identifiers,
  };
  for (const key of [
    "manufacturer", "brand", "country_of_origin", "hs_code", "shelf_life_days", "temperature_regime", "temperature_range",
    "temperature_min_c", "temperature_max_c", "base_uom", "requires_sticker", "requires_marking", "status",
  ]) {
    if (values[key] !== undefined) product[key] = values[key];
  }
  return product;
}

// Converts all tables of one upload into a single package. Identifier and packaging rows
// are attached to the product with the same internal_sku (a product that only appears
// there is sent as an update of an existing product).
export function buildPackageFromTables(tables: Table[]): { pkg: ReferencePackage; issues: Issue[] } {
  const issues: Issue[] = [];
  const pkg: ReferencePackage = { format: IMPORT_FORMAT, version: IMPORT_VERSION, counterparties: [], products: [] };
  const extraIdentifiers: { sku: string; row: number; identifier: ImportIdentifier }[] = [];
  const extraPackaging: { sku: string; row: number; level: ImportPackaging }[] = [];
  const counts = { counterparties: 0, products: 0, children: 0 };

  for (const table of tables) {
    const parsed = readTable(table, issues);
    if (!parsed) continue;
    const key = parsed.kind === "counterparties" || parsed.kind === "products" ? parsed.kind : "children";
    counts[key] += parsed.rows.length;
    for (const { row, values } of parsed.rows) {
      if (parsed.kind === "counterparties") {
        const party = normalizeCounterparty({ row, ...values }, row - 1, table.source, issues);
        if (party) pkg.counterparties.push(party);
      } else if (parsed.kind === "products") {
        if (values.supplier !== undefined && values.supplier_sku === undefined) {
          issues.push({ source: table.source, row, message: "Поставщик указывается вместе с артикулом поставщика (supplier_sku)" });
          continue;
        }
        const product = normalizeProduct(productFromRow(values, row), row - 1, table.source, issues);
        if (product) pkg.products.push(product);
      } else {
        const sku = cleanText(values.internal_sku);
        const c = collector(issues, table.source, row);
        if (!sku) {
          c.fail("Не указан внутренний артикул (internal_sku)");
          continue;
        }
        if (parsed.kind === "identifiers") {
          const identifier = normalizeIdentifier(
            { type: cleanText(values.identifier_type).toLowerCase(), value: values.value, counterparty: values.counterparty,
              packaging_uom: values.packaging_uom, is_primary: values.is_primary },
            c, `Идентификатор товара ${sku}`,
          );
          if (identifier) extraIdentifiers.push({ sku, row, identifier });
        } else {
          const level = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "internal_sku"));
          const normalized = normalizePackagingLevel(level, c, `Упаковка товара ${sku}`);
          if (normalized) extraPackaging.push({ sku, row, level: normalized });
        }
      }
    }
  }

  const bySku = new Map<string, ImportProduct>();
  for (const product of pkg.products) if (!bySku.has(product.internal_sku)) bySku.set(product.internal_sku, product);
  const productFor = (sku: string, row: number) => {
    let product = bySku.get(sku);
    if (!product) {
      product = { row, internal_sku: sku, identifiers: [], packaging: [] };
      bySku.set(sku, product);
      pkg.products.push(product);
    }
    return product;
  };
  for (const { sku, row, identifier } of extraIdentifiers) productFor(sku, row).identifiers.push(identifier);
  for (const { sku, row, level } of extraPackaging) productFor(sku, row).packaging.push(level);
  for (const product of pkg.products) {
    checkChildLimits(product.identifiers.length, product.packaging.length, collector(issues, "Пакет", product.row), `Товар ${product.internal_sku}`);
  }
  // An identifier or packaging row names a product too, so it counts towards the limit.
  const products = Math.max(counts.products, pkg.products.length) || counts.children;
  if (!issues.length || counts.counterparties || products) checkPackageLimits(counts.counterparties, products, issues, "Пакет");
  return { pkg, issues };
}
