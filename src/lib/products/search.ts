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

export const PRODUCT_SEARCH_FIELDS = ["all", "barcode", "article", "name", "weight", "volume", "brand", "manufacturer", "category", "hs_code"] as const;
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

function grams(value: string, unit: string | undefined) {
  const amount = Number(value.replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  return /^(кг|kg|килограмм)/i.test(unit ?? "") ? amount * 1000 : amount;
}

function weightsFromText(value: string) {
  const result: number[] = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*(кг|kg|килограмм(?:а|ов)?|г|гр|g|грамм(?:а|ов)?)(?=$|[^a-zа-я])/gi;
  for (const match of value.matchAll(pattern)) {
    const parsed = grams(match[1], match[2]);
    if (parsed !== null) result.push(parsed);
  }
  return result;
}

function milliliters(value: string, unit: string | undefined) {
  const amount = Number(value.replace(",", "."));
  if (!Number.isFinite(amount)) return null;
  return /^(л|l|литр)/i.test(unit ?? "") ? amount * 1000 : amount;
}

function volumesFromText(value: string) {
  const result: number[] = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*(мл|ml|миллилитр(?:а|ов)?|л|l|литр(?:а|ов)?)(?=$|[^a-zа-я])/gi;
  for (const match of value.matchAll(pattern)) {
    const parsed = milliliters(match[1], match[2]);
    if (parsed !== null) result.push(parsed);
  }
  return result;
}

function requestedWeight(query: string) {
  const match = query.trim().match(/^(\d+(?:[.,]\d+)?)\s*(кг|kg|килограмм(?:а|ов)?|г|гр|g|грамм(?:а|ов)?)?\.?$/i);
  return match ? grams(match[1], match[2]) : null;
}

function requestedVolume(query: string) {
  const match = query.trim().match(/^(\d+(?:[.,]\d+)?)\s*(мл|ml|миллилитр(?:а|ов)?|л|l|литр(?:а|ов)?)?\.?$/i);
  return match ? milliliters(match[1], match[2]) : null;
}

function matchesWeight(product: ProductSearchData, query: string) {
  const requested = requestedWeight(query);
  if (requested === null) return false;
  const displayedName = product.name?.ru || product.name?.en || product.name?.kk || "";
  const weightsInNames = weightsFromText(displayedName);
  // The product name is the catalogue's declared consumer grammage. Imported
  // packaging data and hidden translations can lag behind a renamed/resized
  // SKU, so they must not override the grammage shown in the catalogue.
  const productWeights = weightsInNames.length ? weightsInNames : [
    ...(!["Напитки", "Вода"].includes(product.category) ? product.packaging.filter(level => level.uom === "piece").flatMap(level =>
      [level.net_weight_kg].flatMap(value => {
        if (value === null || value === "") return [];
        const kg = Number(value);
        return Number.isFinite(kg) ? [kg * 1000] : [];
      })) : []),
  ];
  return productWeights.some(value => Math.abs(value - requested) < 0.001);
}

function matchesVolume(product: ProductSearchData, query: string) {
  const requested = requestedVolume(query);
  if (requested === null) return false;
  const productVolumes = Object.values(product.name ?? {}).flatMap(volumesFromText);
  return productVolumes.some(value => Math.abs(value - requested) < 0.001);
}

function valuesForField(product: ProductSearchData, field: ProductSearchField) {
  const barcodeValues = product.identifiers.filter(identifier => ["gtin", "unit_barcode", "box_barcode"].includes(identifier.identifier_type)).map(identifier => identifier.value);
  const articleValues = [product.internal_sku, ...product.identifiers.filter(identifier => identifier.identifier_type === "supplier_sku").map(identifier => identifier.value)];
  const weightValues = [
    ...Object.values(product.name ?? {}),
    ...product.packaging.filter(level => level.uom === "piece").flatMap(level => [
      ...weightTerms(level.net_weight_kg),
      ...weightTerms(level.gross_weight_kg),
    ]),
  ];
  const groups: Record<Exclude<ProductSearchField, "all">, (string | null | undefined)[]> = {
    barcode: barcodeValues,
    article: articleValues,
    name: Object.values(product.name ?? {}),
    weight: weightValues,
    volume: Object.values(product.name ?? {}),
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
  if (field === "weight") return !query.trim() || matchesWeight(product, query);
  if (field === "volume") return !query.trim() || matchesVolume(product, query);
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  const values = valuesForField(product, field).filter((value): value is string => Boolean(value));
  const haystack = normalize(values.join(" "));
  const compactValues = values.map(value => normalize(value).replace(/[^a-zа-я0-9]/gi, ""));
  return normalizedQuery.split(/\s+/).every(term =>
    haystack.includes(term) || compactValues.some(value => value.includes(term.replace(/[^a-zа-я0-9]/gi, ""))));
}
