import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchSuppliers, orderCodes, suggestFromFolder, suggestRoute } from "../../src/lib/shipments/drive-order.ts";

// Synthetic prefixes and parties shaped like the real ones; ids are placeholders.
const C1 = "11111111-1111-4111-8111-111111111111", C2 = "22222222-2222-4222-8222-222222222222", C3 = "33333333-3333-4333-8333-333333333333";
const prefixes = [
  { prefix: "AB", counterparty_id: C1, is_own_stock: false },
  { prefix: "Cd", counterparty_id: C2, is_own_stock: false },
  { prefix: "OW", counterparty_id: null, is_own_stock: true },
  { prefix: "EF", counterparty_id: C3, is_own_stock: false },
];
const suppliers = [
  { id: "s-nordic", legal_name: "Nordic Confectionary Ltd", country: "FI" },
  { id: "s-delta", legal_name: "Delta Bakery b.v.", country: "NL" },
  { id: "s-alpha", legal_name: "Alpha GmbH", country: "DE" },
  { id: "s-yildiz", legal_name: "YILDIZ GIDA ENTEGRE SAN. VE TİC. A.Ş,", country: "TR" },
];

describe("order folder names", () => {
  it("reads the order code of a new order folder", () => {
    assert.deepEqual(orderCodes("AB-50 Nordic гендеры 2027", prefixes).map(code => code.code), ["AB-50"]);
    assert.deepEqual(orderCodes("OW-10", prefixes).map(code => [code.code, code.own]), [["OW-10", true]]);
  });

  it("reads prefixes written without a dash and ignores the archive numbering", () => {
    assert.deepEqual(orderCodes("Nordic Гендеры Cdx12-x", prefixes).map(code => code.code), ["Cd-12"]);
    assert.deepEqual(orderCodes("04_03_AB-48 батончики, AB-49 Delta", prefixes).map(code => code.code), ["AB-48", "AB-49"]);
    assert.deepEqual(orderCodes("EF-06 батончики", prefixes).map(code => code.code), ["EF-06"]);
  });

  it("does not take a year or a part of a word for an order", () => {
    assert.deepEqual(orderCodes("Nordic 2027 гендеры", prefixes), []);
    assert.deepEqual(orderCodes("TAB-50 Nordic", prefixes), []);
  });

  it("finds the supplier by the distinctive word of its name", () => {
    assert.deepEqual(matchSuppliers("AB-50 Nordic гендеры 2027", suppliers).map(party => party.id), ["s-nordic"]);
    assert.deepEqual(matchSuppliers("04_03_AB-48 батончики, AB-49 Delta", suppliers).map(party => party.id), ["s-delta"]);
    assert.deepEqual(matchSuppliers("GE-16 Yıldız паста", suppliers).map(party => party.id), ["s-yildiz"]);
    assert.deepEqual(matchSuppliers("OW-10", suppliers), []);
  });

  it("suggests the project code, customers from subfolders and the supplier", () => {
    const suggestion = suggestFromFolder("AB-50 Nordic гендеры 2027", ["AB-50", "EF-06 батончики"], prefixes, suppliers);
    assert.equal(suggestion.projectCode, "AB-50");
    assert.deepEqual(suggestion.codes.map(code => code.code), ["AB-50", "EF-06"]);
    assert.deepEqual(suggestion.customers, [C1, C3]);
    assert.equal(suggestion.ownStock, false);
    assert.deepEqual(suggestion.supplierIds, ["s-nordic"]);
  });

  it("marks own Kazakhstan stock and suggests the only route from the supplier's country", () => {
    assert.equal(suggestFromFolder("OW-10", [], prefixes, suppliers).ownStock, true);
    const routes = [{ id: "r1", origin_country: "FI", destination_country: "KZ" }, { id: "r2", origin_country: "TR", destination_country: "GE" }];
    assert.equal(suggestRoute("FI", routes), "r1");
    assert.equal(suggestRoute("TR", routes), null);
    assert.equal(suggestRoute(null, routes), null);
  });
});
