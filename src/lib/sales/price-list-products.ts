// The price list shows only products that already have a price (public.price_list). A manual price can be set for
// any active product (public.set_price_list_price), so the manager picks a product without prices from this list —
// for example a price type the calculator has no column for, such as consignment.

export type CatalogProduct = { id: string; internal_sku: string; name: unknown };
export type PricedProduct = { id: string; sku: string; name: string };
export type PriceProductChoice = { id: string; sku: string; name: string; hasPrices: boolean };

// The same name as public.price_list shows: the Russian name, otherwise the article.
export function productLabel(product: CatalogProduct): string {
  const name = product.name && typeof product.name === "object" ? (product.name as Record<string, unknown>).ru : null;
  return typeof name === "string" && name.trim() ? name : product.internal_sku;
}

/** Active products that have no price of any type yet, by article. */
export function productsWithoutPrices(catalog: readonly CatalogProduct[], priced: readonly PricedProduct[]): PriceProductChoice[] {
  const withPrices = new Set(priced.map((row) => row.id));
  return catalog
    .filter((product) => !withPrices.has(product.id))
    .map((product) => ({ id: product.id, sku: product.internal_sku, name: productLabel(product), hasPrices: false }))
    .sort((a, b) => a.sku.localeCompare(b.sku, "ru") || a.id.localeCompare(b.id));
}

/** The product whose history and manual price form are open: one with prices, or else one without prices yet. */
export function selectedPriceProduct(
  productId: string | null,
  priced: readonly PricedProduct[],
  withoutPrices: readonly PriceProductChoice[],
): PriceProductChoice | null {
  if (!productId) return null;
  const row = priced.find((item) => item.id === productId);
  if (row) return { id: row.id, sku: row.sku, name: row.name, hasPrices: true };
  return withoutPrices.find((item) => item.id === productId) ?? null;
}
