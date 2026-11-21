import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productLabel, productsWithoutPrices, selectedPriceProduct } from "../../src/lib/sales/price-list-products.ts";

const a = "a1a1a1a1-1111-4111-8111-111111111111", b = "b2b2b2b2-2222-4222-8222-222222222222", c = "c3c3c3c3-3333-4333-8333-333333333333";
const catalog = [
  { id: c, internal_sku: "SKU-3", name: { ru: "Конфеты" } },
  { id: a, internal_sku: "SKU-1", name: { ru: "Шоколад" } },
  { id: b, internal_sku: "SKU-2", name: { en: "Biscuits" } },
];
const priced = [{ id: a, sku: "SKU-1", name: "Шоколад" }];

describe("products for a manual price", () => {
  it("names a product like the price list: Russian name, otherwise the article", () => {
    assert.equal(productLabel(catalog[0]), "Конфеты");
    assert.equal(productLabel(catalog[2]), "SKU-2");
    assert.equal(productLabel({ id: a, internal_sku: "SKU-1", name: { ru: "  " } }), "SKU-1");
    assert.equal(productLabel({ id: a, internal_sku: "SKU-1", name: null }), "SKU-1");
  });

  it("offers only active products without any price, by article", () => {
    assert.deepEqual(productsWithoutPrices(catalog, priced).map((item) => item.sku), ["SKU-2", "SKU-3"]);
    assert.ok(productsWithoutPrices(catalog, priced).every((item) => !item.hasPrices));
    assert.deepEqual(productsWithoutPrices(catalog, catalog.map((p) => ({ id: p.id, sku: p.internal_sku, name: "" }))), []);
  });

  it("opens a product with prices or one without prices yet, and nothing else", () => {
    const without = productsWithoutPrices(catalog, priced);
    assert.deepEqual(selectedPriceProduct(a, priced, without), { id: a, sku: "SKU-1", name: "Шоколад", hasPrices: true });
    assert.deepEqual(selectedPriceProduct(c, priced, without), { id: c, sku: "SKU-3", name: "Конфеты", hasPrices: false });
    assert.equal(selectedPriceProduct("d4d4d4d4-4444-4444-8444-444444444444", priced, without), null);
    assert.equal(selectedPriceProduct(null, priced, without), null);
  });
});
