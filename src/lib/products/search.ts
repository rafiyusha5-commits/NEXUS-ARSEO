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

export function matchesProductSearch(product: ProductSearchData, query: string) {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return true;
  const values = [
    product.internal_sku,
    ...Object.values(product.name ?? {}),
    product.brand,
    product.category,
    product.hs_code,
    product.manufacturer,
    ...product.identifiers.flatMap(identifier => [identifier.value, identifier.identifier_type]),
    ...product.packaging.flatMap(level => [
      level.uom,
      String(level.units_per_parent),
      ...weightTerms(level.net_weight_kg),
      ...weightTerms(level.gross_weight_kg),
    ]),
  ].filter((value): value is string => Boolean(value));
  const haystack = normalize(values.join(" "));
  const compactValues = values.map(value => normalize(value).replace(/[^a-zа-я0-9]/gi, ""));
  return normalizedQuery.split(/\s+/).every(term =>
    haystack.includes(term) || compactValues.some(value => value.includes(term.replace(/[^a-zа-я0-9]/gi, ""))));
}
