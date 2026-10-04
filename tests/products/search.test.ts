import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchesProductSearch, type ProductSearchData } from "../../src/lib/products/search.ts";

const dumle: ProductSearchData = {
  internal_sku: "FAZER-403747",
  name: { ru: "Ирис Dumle 120г", en: "Dumle toffee 120 g" },
  brand: "Dumle",
  category: "Конфеты",
  hs_code: "18069019",
  manufacturer: "Fazer Confectionary Ltd",
  identifiers: [
    { identifier_type: "gtin", value: "6411404035187" },
    { identifier_type: "supplier_sku", value: "403747" },
  ],
  packaging: [
    { uom: "piece", units_per_parent: 1, net_weight_kg: 0.12, gross_weight_kg: 0.125 },
    { uom: "box", units_per_parent: 120, net_weight_kg: 2.4, gross_weight_kg: 2.6 },
    { uom: "pallet", units_per_parent: 150, net_weight_kg: 360, gross_weight_kg: 385 },
  ],
};

describe("universal product search", () => {
  it("finds names, manufacturers, brands and categories", () => {
    assert.equal(matchesProductSearch(dumle, "ирис dumle"), true);
    assert.equal(matchesProductSearch(dumle, "fazer конфеты"), true);
  });

  it("finds internal, supplier and global identifiers", () => {
    assert.equal(matchesProductSearch(dumle, "FAZER-403747"), true);
    assert.equal(matchesProductSearch(dumle, "403747"), true);
    assert.equal(matchesProductSearch(dumle, "6411404035187"), true);
  });

  it("understands common weight spellings and packaging weights", () => {
    assert.equal(matchesProductSearch(dumle, "120 гр"), true);
    assert.equal(matchesProductSearch(dumle, "120 грамм"), true);
    assert.equal(matchesProductSearch(dumle, "0,125 кг"), true);
  });

  it("requires every search word", () => {
    assert.equal(matchesProductSearch(dumle, "dumle 250"), false);
  });

  it("limits matching to the selected field", () => {
    assert.equal(matchesProductSearch(dumle, "6411404035187", "barcode"), true);
    assert.equal(matchesProductSearch(dumle, "403747", "article"), true);
    assert.equal(matchesProductSearch(dumle, "403747", "name"), false);
    assert.equal(matchesProductSearch(dumle, "120 гр", "weight"), true);
    assert.equal(matchesProductSearch(dumle, "Fazer", "manufacturer"), true);
    assert.equal(matchesProductSearch(dumle, "Dumle", "brand"), true);
  });

  it("does not confuse grammage with box or pallet quantities", () => {
    assert.equal(matchesProductSearch(dumle, "120", "weight"), true);
    assert.equal(matchesProductSearch(dumle, "0,12 кг", "weight"), true);
    assert.equal(matchesProductSearch(dumle, "150", "weight"), false);
    assert.equal(matchesProductSearch(dumle, "12", "weight"), false);
    assert.equal(matchesProductSearch(dumle, "2,4 кг", "weight"), false);
  });

  it("uses net grammage and never gross unit weight", () => {
    const biscuit = {
      ...dumle,
      name: { ru: "Печенье Moomin 175г" },
      packaging: [{ uom: "piece", units_per_parent: 1, net_weight_kg: 0.175, gross_weight_kg: 0.25 }],
    };
    assert.equal(matchesProductSearch(biscuit, "175", "weight"), true);
    assert.equal(matchesProductSearch(biscuit, "250", "weight"), false);
  });

  it("separates liquid volume from product grammage", () => {
    const drink = {
      ...dumle,
      name: { ru: "Смузи Froosh 250мл" },
      category: "Напитки",
      packaging: [{ uom: "piece", units_per_parent: 1, net_weight_kg: 0.25, gross_weight_kg: 0.27 }],
    };
    assert.equal(matchesProductSearch(drink, "250", "weight"), false);
    assert.equal(matchesProductSearch(drink, "250", "volume"), true);
    assert.equal(matchesProductSearch(drink, "0,25 л", "volume"), true);
  });

  it("reads grammage from a name even when unit packaging weight is absent", () => {
    const nameOnly = { ...dumle, name: { ru: "Печенье 150г" }, packaging: [] };
    assert.equal(matchesProductSearch(nameOnly, "150", "weight"), true);
    assert.equal(matchesProductSearch(nameOnly, "0,15 кг", "weight"), true);
    assert.equal(matchesProductSearch(nameOnly, "15", "weight"), false);
  });

  it("prefers declared name grammage when imported packaging weight disagrees", () => {
    const resizedProduct = {
      ...dumle,
      name: { ru: "Шоколадные конфеты Fazer 190г", en: "Fazer chocolates 180g" },
      packaging: [{ uom: "piece", units_per_parent: 1, net_weight_kg: 0.18, gross_weight_kg: 0.195 }],
    };
    assert.equal(matchesProductSearch(resizedProduct, "180", "weight"), false);
    assert.equal(matchesProductSearch(resizedProduct, "190", "weight"), true);
  });
});
