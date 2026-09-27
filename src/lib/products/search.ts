export type ProductSearchData = {
  internal_sku: string;
  name: Record<string, string>;
  brand: string | null;
  category: string;
  hs_code: string | null;
  manufacturer: string | null;
  identifiers: { identifier_type: string; value: string }[];
  packaging: { uom: string; units_per_parent: number | string; gross_weight_kg: number | string | null; net_weight_kg: number | string | null }[];
};

export const PRODUCT_SEARCH_FIELDS = ["all", "barcode", "article", "name", "weight", "brand", "manufacturer", "category", "hs_code"] as const;
export type ProductSearchField = (typeof PRODUCT_SEARCH_FIELDS)[number];

function normalize(value: string) {
  return value.toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/(грамм(?:а|ов)?|гр)\.?/g, "г")
    .replace(/(килограмм(?:а|ов)?|килограмм|кг)\.?/g, "кг")
    .replace(/[^a-zа-я0-9.\-]+/gi, " ")
    .trim();
}

function weightTerms(raw: number | string | null) {
  if (raw == null || raw === "") return [];
  const kg = Number(raw);
  if (!Number.isFinite(kg)) return [];
  const grams = Math.round(kg * 1000 * 1000) / 1000;
  return [String(kg), `${kg} кг`, String(grams), `${grams} г`];
}

function valuesForField(product: ProductSearchData, field: ProductSearchField) {
  const barcodeValues = product.identifiers.filter(identifier => ["gtin", "unit_barcode", "box_barcode"].includes(identifier.identifier_type)).map(identifier => identifier.value);
  const articleValues = [product.internal_sku, ...product.identifiers.filter(identifier => identifier.identifier_type === "supplier_sku").map(identifier => identifier.value)];
  const weightValues = [
    ...Object.values(product.name ?? {}),
    ...product.packaging.flatMap(level => [
      String(level.units_per_parent),
      ...weightTerms(level.net_weight_kg),
      ...weightTerms(level.gross_weight_kg),
    ]),
  ];
  const groups: Record<Exclude<ProductSearchField, "all">, (string | null | undefined)[]> = {
    barcode: barcodeValues,
    article: articleValues,
    name: Object.values(product.name ?? {}),
    weight: weightValues,
    brand: [product.brand],
    manufacturer: [product.manufacturer],
    category: [product.category],
    hs_code: [product.hs_code],
  };
  if (field !== "all") return groups[field];
  return [
    ...articleValues,
    ...Object.values(product.name ?? {}),
    product.brand,
    product.category,
    product.hs_code,
    product.manufacturer,
    ...barcodeValues,
    ...weightValues,
  ];
}

export function matchesProductSearch(product: ProductSearchData, query: string, field: ProductSearchField = "all") {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  const values = valuesForField(product, field).filter((value): value is string => Boolean(value));
  const haystack = normalize(values.join(" "));
  const compactValues = values.map(value => normalize(value).replace(/[^a-zа-я0-9]/gi, ""));
  return normalizedQuery.split(/\s+/).every(term =>
    haystack.includes(term) || compactValues.some(value => value.includes(term.replace(/[^a-zа-я0-9]/gi, ""))));
}
