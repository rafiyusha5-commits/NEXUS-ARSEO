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
  packaging: [{ uom: "piece", units_per_parent: 1, net_weight_kg: 0.12, gross_weight_kg: 0.125 }],
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
});
